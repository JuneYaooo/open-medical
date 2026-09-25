#!/usr/bin/env python3
"""Authenticated, read-only adapter for the official WeCom Finance C SDK."""
import base64
import ctypes as C
import datetime as dt
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 65536
MAX_REPLY = 4_000_000
MAX_SEQ = (1 << 64) - 1


class CollectorError(Exception):
    pass


def sequence(value):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", value) or int(value) > MAX_SEQ:
        raise CollectorError("invalid_cursor")
    return int(value)


def normalize(raw, seq, members):
    sender = raw.get("from", "")
    recipients = raw.get("tolist", [])
    if not isinstance(sender, str) or not isinstance(recipients, list) or not all(isinstance(v, str) for v in recipients):
        raise CollectorError("invalid_message_identity")
    participants = set(recipients + [sender])
    if not participants.intersection(members):
        return None
    room = raw.get("roomid")
    if room:
        conversation = "room:" + room
    elif len(participants) == 2:
        conversation = "private:" + ":".join(sorted(participants))
    else:
        return None
    kind = raw.get("msgtype", raw.get("action", "unknown"))
    content = raw.get("text", {}).get("content", "") if kind == "text" else ""
    if not isinstance(content, str) or len(content) > 20000:
        raise CollectorError("message_too_large")
    timestamp = raw.get("msgtime")
    sent_at = dt.datetime.fromtimestamp(timestamp / 1000, dt.timezone.utc).isoformat() if isinstance(timestamp, (int, float)) and timestamp > 0 else None
    return {"id": raw["msgid"], "seq": str(seq), "conversationId": conversation, "senderId": sender,
            "direction": "out" if sender in members else "in", "sentAt": sent_at, "type": kind,
            "text": content, "action": raw.get("action", "send"), "revokedMessageId": raw.get("revoke", {}).get("pre_msgid")}


class FinanceSDK:
    def __init__(self, library, corp_id, secret, key_directory):
        self.keys = Path(key_directory).resolve(strict=True)
        if not self.keys.is_dir():
            raise CollectorError("private_key_directory_missing")
        self.lib = C.CDLL(str(Path(library).resolve(strict=True)))
        self.lock = threading.Lock()
        signatures = {
            "NewSdk": ([], C.c_void_p), "DestroySdk": ([C.c_void_p], None),
            "Init": ([C.c_void_p, C.c_char_p, C.c_char_p], C.c_int),
            "NewSlice": ([], C.c_void_p), "FreeSlice": ([C.c_void_p], None),
            "GetContentFromSlice": ([C.c_void_p], C.c_void_p), "GetSliceLen": ([C.c_void_p], C.c_int),
            "GetChatData": ([C.c_void_p, C.c_ulonglong, C.c_uint, C.c_char_p, C.c_char_p, C.c_int, C.c_void_p], C.c_int),
            "DecryptData": ([C.c_char_p, C.c_char_p, C.c_void_p], C.c_int),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(self.lib, name)
            fn.argtypes, fn.restype = args, result
        self.handle = self.lib.NewSdk()
        if not self.handle:
            raise CollectorError("sdk_allocation_failed")
        if self.lib.Init(self.handle, corp_id.encode(), secret.encode()) != 0:
            self.close()
            raise CollectorError("sdk_initialization_failed")

    def close(self):
        if self.handle:
            self.lib.DestroySdk(self.handle)
            self.handle = None

    def call_slice(self, fn, *args):
        result = self.lib.NewSlice()
        if not result:
            raise CollectorError("sdk_allocation_failed")
        try:
            if fn(*args, result) != 0:
                raise CollectorError("sdk_request_failed")
            length = self.lib.GetSliceLen(result)
            if not 0 < length <= MAX_REPLY:
                raise CollectorError("sdk_response_size")
            value = json.loads(C.string_at(self.lib.GetContentFromSlice(result), length))
            if value.get("errcode", 0) != 0:
                raise CollectorError("sdk_permission_or_request_failed")
            return value
        finally:
            self.lib.FreeSlice(result)

    def decrypt(self, encrypted):
        version = encrypted.get("publickey_ver")
        if not isinstance(version, int) or not 0 < version < (1 << 32):
            raise CollectorError("invalid_key_version")
        key = self.keys / f"{version}.pem"
        if key.is_symlink() or not key.is_file() or (os.name != "nt" and key.stat().st_mode & 0o077):
            raise CollectorError("private_key_missing_or_permissions")
        try:
            decoded = base64.b64decode(encrypted["encrypt_random_key"], validate=True)
            opened = subprocess.run(["openssl", "pkeyutl", "-decrypt", "-inkey", str(key), "-pkeyopt", "rsa_padding_mode:pkcs1"],
                                    input=decoded, capture_output=True, timeout=5, check=True).stdout
            if not opened or b"\x00" in opened:
                raise CollectorError("invalid_message_key")
            raw = self.call_slice(self.lib.DecryptData, opened, encrypted["encrypt_chat_msg"].encode())
            if raw.get("msgid") != encrypted.get("msgid"):
                raise CollectorError("message_identity_mismatch")
            return raw
        except CollectorError:
            raise
        except Exception:
            raise CollectorError("message_decryption_failed") from None

    def read(self, cursor, limit):
        with self.lock:
            page = self.call_slice(self.lib.GetChatData, self.handle, cursor, limit, b"", b"", 10)
            rows = page.get("chatdata")
            if not isinstance(rows, list) or len(rows) > limit:
                raise CollectorError("invalid_sdk_page")
            previous = cursor
            messages = []
            for item in rows:
                seq = item.get("seq")
                if isinstance(seq, bool) or not isinstance(seq, int) or not previous < seq <= MAX_SEQ:
                    raise CollectorError("invalid_sdk_sequence")
                messages.append((seq, self.decrypt(item)))
                previous = seq
            return messages, previous, len(rows) == limit


class Collector:
    def __init__(self, sdk, corp_id, token, members):
        if len(token) < 32 or not members or not corp_id:
            raise CollectorError("collector_configuration_incomplete")
        self.sdk, self.corp_id, self.token, self.members = sdk, corp_id, token, set(members)
        self.busy = threading.Lock()

    def response(self, data):
        return {"version": 1, "corpId": self.corp_id, **data}

    def conversations(self):
        if not self.busy.acquire(blocking=False):
            raise CollectorError("collector_busy")
        try:
            cursor, found, more = 0, {}, False
            for _ in range(10):
                rows, cursor, more = self.sdk.read(cursor, 100)
                for seq, raw in rows:
                    message = normalize(raw, seq, self.members)
                    if message:
                        found[message["conversationId"]] = {"id": message["conversationId"], "lastMessageAt": message["sentAt"]}
                if not more:
                    break
            return self.response({"conversations": list(found.values())[:500], "partial": more or len(found) > 500})
        finally:
            self.busy.release()

    def read(self, data):
        cursor = sequence(data.get("cursor"))
        limit = data.get("limit", 100)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise CollectorError("invalid_limit")
        conversations = data.get("conversations", [])
        if not isinstance(conversations, list) or len(conversations) > 500 or not all(isinstance(v, str) and 0 < len(v) <= 300 for v in conversations):
            raise CollectorError("invalid_conversation_scope")
        if not conversations:
            raise CollectorError("conversation_scope_required")
        if not self.busy.acquire(blocking=False):
            raise CollectorError("collector_busy")
        try:
            rows, next_cursor, more = self.sdk.read(cursor, limit)
            output = []
            for seq, raw in rows:
                message = normalize(raw, seq, self.members)
                if message and message["conversationId"] in conversations:
                    output.append(message)
            return self.response({"messages": output, "nextCursor": str(next_cursor), "hasMore": more})
        finally:
            self.busy.release()


def handler(collector):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"
        def log_message(self, *_args):
            pass  # Do not log chat contents, tokens or request headers.

        def send_json(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode()
            if len(body) > MAX_REPLY:
                status, body = 502, b'{"error":"response_too_large"}'
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            self.connection.settimeout(15)
            supplied = self.headers.get("Authorization", "")
            return hmac.compare_digest(supplied.encode(), ("Bearer " + collector.token).encode())

        def do_GET(self):
            if not self.authorized():
                return self.send_json(401, {"error": "unauthorized"})
            if self.path == "/v1/conversations":
                try:
                    return self.send_json(200, collector.conversations())
                except Exception:
                    return self.send_json(502, {"error": "conversation_discovery_failed"})
            if self.path != "/v1/status":
                return self.send_json(404, {"error": "not_found"})
            # Init alone does not prove that the actual archive credentials work.
            try:
                collector.sdk.read(0, 1)
                self.send_json(200, collector.response({"ready": True, "capabilities": ["text", "message-metadata"]}))
            except Exception:
                self.send_json(503, collector.response({"ready": False, "error": "archive_probe_failed"}))

        def do_POST(self):
            if not self.authorized():
                return self.send_json(401, {"error": "unauthorized"})
            if self.path != "/v1/messages":
                return self.send_json(404, {"error": "not_found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY or self.headers.get("Transfer-Encoding"):
                    return self.send_json(413, {"error": "invalid_body_size"})
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise CollectorError("invalid_body")
                self.send_json(200, collector.read(data))
            except CollectorError as error:
                self.send_json(502, {"error": str(error)})
            except Exception:
                self.send_json(502, {"error": "collector_request_failed"})
    return Handler


def main():
    required = ["WECOM_CORP_ID", "WECOM_ARCHIVE_SECRET", "WECOM_ARCHIVE_TOKEN", "WECOM_SDK_LIBRARY", "WECOM_PRIVATE_KEYS", "WECOM_MEMBERS"]
    if any(not os.environ.get(key) for key in required):
        raise CollectorError("missing_configuration")
    sdk = FinanceSDK(os.environ["WECOM_SDK_LIBRARY"], os.environ["WECOM_CORP_ID"], os.environ["WECOM_ARCHIVE_SECRET"], os.environ["WECOM_PRIVATE_KEYS"])
    collector = Collector(sdk, os.environ["WECOM_CORP_ID"], os.environ["WECOM_ARCHIVE_TOKEN"], [v.strip() for v in os.environ["WECOM_MEMBERS"].split(",") if v.strip()])
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("WECOM_ARCHIVE_PORT", "8789"))), handler(collector))
    try:
        print("WeCom archive collector listening on loopback", flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        sdk.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("Collector unavailable: check configuration, SDK architecture, private-key permissions and archive access.")
