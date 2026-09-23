import test from 'node:test';
import assert from 'node:assert/strict';
import {medicalExcerpt} from '../shared/medical-excerpt.mjs';
test('publisher headings and superscripts become readable text without HTML injection',()=>{
 assert.equal(medicalExcerpt('<h4>Case presentation</h4>A 71-year-old man underwent <sup>18</sup>F-FAPI.'),'Case presentation\nA 71-year-old man underwent 18F-FAPI.');
 assert.equal(medicalExcerpt('&lt;h4&gt;Conclusion&lt;/h4&gt;A &amp; B'),'Conclusion\nA & B');
 assert.equal(medicalExcerpt('<script>bad()</script><p>Saved text</p><img src=x onerror=x()>'),'Saved text');
 assert.equal(medicalExcerpt('value < 120'),'value < 120');
});
