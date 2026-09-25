import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recognizeImage,localOcrAvailable} from '../server/core/image-ocr.mjs';
test('native Apple Vision crops evidence to selected region and returns source coordinates',{skip:!localOcrAvailable()},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chat-ocr-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const swift=join(dir,'fixture.swift'),png=join(dir,'fixture.png');
 await writeFile(swift,`import Cocoa\nlet image=NSImage(size:NSSize(width:800,height:400))\nimage.lockFocus()\nNSColor.white.setFill();NSRect(x:0,y:0,width:800,height:400).fill()\nlet attrs:[NSAttributedString.Key:Any]=[.font:NSFont.systemFont(ofSize:40),.foregroundColor:NSColor.black]\n("TITLE ONLY" as NSString).draw(at:NSPoint(x:50,y:300),withAttributes:attrs)\n("MESSAGE ONLY" as NSString).draw(at:NSPoint(x:50,y:80),withAttributes:attrs)\nimage.unlockFocus()\nlet bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!\ntry bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))\n`);
 await promisify(execFile)('swift',[swift,png],{timeout:45000});
 const bytes=await readFile(png);
 const result=await recognizeImage(bytes,undefined,{region:{x:0,y:0,width:1,height:.5},includeImage:true});
 assert.match(result.lines.map(l=>l.text).join(' '),/TITLE ONLY/);assert.doesNotMatch(result.lines.map(l=>l.text).join(' '),/MESSAGE ONLY/);
 assert.ok(result.image&&result.lines.every(l=>l.box&&l.box.x>=0&&l.box.y>=0));
 const crop=await recognizeImage(Buffer.from(result.image,'base64'));assert.match(crop.lines.map(l=>l.text).join(' '),/TITLE ONLY/);assert.doesNotMatch(crop.lines.map(l=>l.text).join(' '),/MESSAGE ONLY/);
});
