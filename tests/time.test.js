import test from 'node:test';
import assert from 'node:assert/strict';
import {frameAt,mediaTime} from '../dist/time.js';
test('all controls snap to the same nonzero episode frame grid',()=>{
 const times=[5,5.033333,5.066667,5.1];
 assert.deepEqual(frameAt(times,5.041),{index:1,time:5.033333});
 assert.ok(Math.abs(mediaTime(frameAt(times,5.041).time,5,12)-12.033333)<1e-12);
 assert.equal(frameAt(times,5.041,5.05,5.1).time,5.066667);
 assert.equal(frameAt(times,8).time,5.1);
 assert.equal(frameAt(times,0).time,5);
});
test('window between frames does not escape bounds',()=>{
 const f=frameAt([0,1,2],.5,.4,.6);assert.ok(f.time>=.4&&f.time<=.6);
});
