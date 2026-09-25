import importlib.util
import base64
import json
from pathlib import Path
import threading
import tempfile
import subprocess
import os
import shutil
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('collector', Path(__file__).resolve().parents[1] / 'integrations/wecom-archive/collector.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

class SDK:
    def read(self, cursor, limit):
        return [(cursor+1, {'msgid':'synthetic-message','from':'family','tolist':['doctor'],'msgtype':'text','msgtime':1758700800000,'text':{'content':'合成家属反馈'}})], cursor+1, False

class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.collector=c.Collector(SDK(),'synthetic-corp','x'*32,['doctor'])
    def test_normalization_and_scope(self):
        result=self.collector.read({'cursor':'9007199254740993','limit':100,'conversations':['private:doctor:family']})
        self.assertEqual(result['nextCursor'],'9007199254740994')
        self.assertEqual(result['messages'][0]['senderId'],'family')
        self.assertEqual(result['messages'][0]['direction'],'in')
        empty=self.collector.read({'cursor':'0','conversations':['private:doctor:other']})
        self.assertEqual(empty['messages'],[])
        self.assertEqual(empty['nextCursor'],'1')
    def test_invalid_cursor_limits_and_missing_scope(self):
        for cursor in [1, True, '-1','18446744073709551616','01']:
            with self.assertRaises(c.CollectorError):c.sequence(cursor)
        self.assertEqual(c.sequence('18446744073709551615'),18446744073709551615)
        for data in [{'cursor':'0'},{'cursor':'0','limit':True,'conversations':['room:a']},{'cursor':'0','limit':101,'conversations':['room:a']}]:
            with self.assertRaises(c.CollectorError):self.collector.read(data)
    def test_nontext_not_invented_and_internal_scope(self):
        message={'msgid':'s','from':'doctor','tolist':['family'],'msgtype':'voice','msgtime':1}
        normalized=c.normalize(message,1,{'doctor'})
        self.assertEqual(normalized['text'],'')
        self.assertEqual(normalized['type'],'voice')
        self.assertEqual(normalized['direction'],'out')
        self.assertIsNone(c.normalize(message,1,{'other'}))
    def test_http_authentication_and_protocol(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),c.handler(self.collector))
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        base=f'http://127.0.0.1:{server.server_port}'
        with self.assertRaises(urllib.error.HTTPError) as denied:urllib.request.urlopen(base+'/v1/status',timeout=2)
        self.assertEqual(denied.exception.code,401)
        headers={'Authorization':'Bearer '+'x'*32,'Content-Type':'application/json'}
        status=json.load(urllib.request.urlopen(urllib.request.Request(base+'/v1/status',headers=headers),timeout=2))
        self.assertTrue(status['ready']);self.assertEqual(status['corpId'],'synthetic-corp')
        payload=json.dumps({'cursor':'0','limit':100,'conversations':['private:doctor:family']}).encode()
        result=json.load(urllib.request.urlopen(urllib.request.Request(base+'/v1/messages',data=payload,headers=headers),timeout=2))
        self.assertEqual(result['messages'][0]['text'],'合成家属反馈')
        with self.assertRaises(urllib.error.HTTPError) as too_large:urllib.request.urlopen(urllib.request.Request(base+'/v1/messages',data=b'a'*65537,headers=headers),timeout=2)
        self.assertEqual(too_large.exception.code,413)

class NativeBoundaryTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('cc') and shutil.which('openssl'), 'C compiler and OpenSSL required')
    def test_ctypes_sdk_boundary_and_rsa_key_versions(self):
        with tempfile.TemporaryDirectory(prefix='chat-sdk-test-') as directory:
            root=Path(directory)
            key=root/'1.pem'; public=root/'public.pem'
            subprocess.run(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',str(key)],check=True,capture_output=True)
            key.chmod(0o600)
            subprocess.run(['openssl','pkey','-in',str(key),'-pubout','-out',str(public)],check=True,capture_output=True)
            encrypted=subprocess.run(['openssl','pkeyutl','-encrypt','-pubin','-inkey',str(public),'-pkeyopt','rsa_padding_mode:pkcs1'],input=b'fixture-key',check=True,capture_output=True).stdout
            raw={'msgid':'native-fixture','from':'family','tolist':['doctor'],'msgtype':'text','msgtime':1,'text':{'content':'synthetic SDK boundary'}}
            page={'errcode':0,'chatdata':[{'seq':9007199254740994,'msgid':'native-fixture','publickey_ver':1,'encrypt_random_key':base64.b64encode(encrypted).decode(),'encrypt_chat_msg':'synthetic-cipher'}]}
            code = r"""
#include <stdlib.h>
#include <string.h>
typedef struct { char* data; int len; } Slice;
static int outstanding=0;
void* NewSdk(void) { return malloc(1); }
void DestroySdk(void* p) { free(p); }
int Init(void* p,const char* corp,const char* secret) { return p && !strcmp(corp,"synthetic-corp") && !strcmp(secret,"synthetic-secret") ? 0 : 1; }
void* NewSlice(void) { outstanding++; return calloc(1,sizeof(Slice)); }
void FreeSlice(void* p) { Slice* s=p;free(s->data);free(s);outstanding--; }
void* GetContentFromSlice(void* p) { return ((Slice*)p)->data; }
int GetSliceLen(void* p) { return ((Slice*)p)->len; }
int Outstanding(void) { return outstanding; }
static int fill(void* p,const char* text) { Slice* s=p;s->data=strdup(text);s->len=strlen(text);return 0; }
int GetChatData(void* sdk,unsigned long long seq,unsigned int limit,const char* proxy,const char* password,int timeout,void* out) { if(seq!=9007199254740993ULL || limit!=100 || timeout!=10)return 99;return fill(out,PAGE); }
int DecryptData(const char* key,const char* encrypted,void* out) { if(strcmp(key,"fixture-key")) return 88;return fill(out,RAW); }
""".replace('PAGE',json.dumps(json.dumps(page))).replace('RAW',json.dumps(json.dumps(raw)))
            source=root/'sdk.c';source.write_text(code);library=root/'libfixture.so'
            subprocess.run(['cc','-shared','-fPIC',str(source),'-o',str(library)],check=True,capture_output=True)
            sdk=c.FinanceSDK(library,'synthetic-corp','synthetic-secret',root)
            try:
                rows,cursor,more=sdk.read(9007199254740993,100)
                self.assertEqual(cursor,9007199254740994)
                self.assertEqual(rows[0][1]['text']['content'],'synthetic SDK boundary')
                self.assertFalse(more)
                self.assertEqual(sdk.lib.Outstanding(),0)
                key.chmod(0o644)
                if os.name!='nt':
                    with self.assertRaises(c.CollectorError):sdk.read(9007199254740993,100)
                    self.assertEqual(sdk.lib.Outstanding(),0)
            finally:sdk.close()

if __name__=='__main__': unittest.main()
