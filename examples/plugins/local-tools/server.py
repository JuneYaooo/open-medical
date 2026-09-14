"""Minimal portable MCP example, intentionally dependency-free for offline installation."""
import json
import sys

for line in sys.stdin:
    try:
        request = json.loads(line)
        if "id" not in request:
            continue
        method = request.get("method")
        params = request.get("params", {})
        if method == "initialize":
            result = {"protocolVersion": params.get("protocolVersion", "2025-11-25"), "capabilities": {"tools": {}, "resources": {}, "prompts": {}}, "serverInfo": {"name": "offline-example", "version": "1.0.0"}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [{"name": "sum_numbers", "description": "Add numeric values, no filesystem or network access", "inputSchema": {"type": "object", "properties": {"values": {"type": "array", "items": {"type": "number"}, "minItems": 1, "maxItems": 100}}, "required": ["values"], "additionalProperties": False}}]}
        elif method == "tools/call" and params.get("name") == "sum_numbers":
            result = {"content": [{"type": "text", "text": str(sum(params["arguments"]["values"]))}]}
        elif method == "resources/list":
            result = {"resources": [{"uri": "example://about", "name": "about", "mimeType": "text/plain"}]}
        elif method == "resources/templates/list":
            result = {"resourceTemplates": []}
        elif method == "resources/read" and params.get("uri") == "example://about":
            result = {"contents": [{"uri": "example://about", "mimeType": "text/plain", "text": "Offline MCP sample"}]}
        elif method == "prompts/list":
            result = {"prompts": [{"name": "explain", "description": "Explain a calculation"}]}
        elif method == "prompts/get" and params.get("name") == "explain":
            result = {"messages": [{"role": "user", "content": {"type": "text", "text": "Explain the calculation using only verified tool results."}}]}
        else:
            print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Unknown method or resource"}}), flush=True)
            continue
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
    except (ValueError, KeyError, TypeError) as error:
        print(json.dumps({"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32602, "message": str(error)}}), flush=True)
