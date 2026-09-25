import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleDelta} from '../server/chat-connectors/visible-delta.mjs';
test('visible windows remove strong overlap, preserve uncertain repeated short replies and expose gaps',()=>{
 assert.equal(visibleDelta('上次复查的安排已经确认\n明天上午九点请到门诊','明天上午九点请到门诊\n新的反馈').gap,true);
 const previous='较早消息\n上次复查的安排已经确认\n明天上午九点请到门诊';
 const current='上次复查的安排已经确认\n明天上午九点请到门诊\n合成新增反馈';
 assert.deepEqual(visibleDelta(previous,current),{text:'合成新增反馈',gap:false});
 assert.deepEqual(visibleDelta('好的','好的'),{text:'',gap:false});
 assert.deepEqual(visibleDelta('旧消息\n好的','好的\n明天'),{text:'好的\n明天',gap:true});
 assert.deepEqual(visibleDelta('',current),{text:current,gap:false,firstCapture:true});
});
