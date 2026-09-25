import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('archive collector authenticated HTTP and normalization contract',async()=>{
 const {stderr}=await promisify(execFile)('python3',['tests/chat-collector-python.py'],{timeout:30000});assert.match(stderr,/OK/);
});
