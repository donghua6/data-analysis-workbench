import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize,parseCSV,metrics,nearest,diagnoseEpisode} from '../dist/data.js';
test('asynchronous sampling uses tolerance and does not pair missing data',()=>{const j={state:[[0,1],[.1,2],[.2,9]],action:[[.01,1.5],[.11,2.5]]};assert.deepEqual(metrics(j,0,1,.02),{mae:.5,max:.5,count:2});assert.deepEqual(metrics(j,0,1,.001),{mae:null,max:null,count:0});assert.equal(metrics(j,.1,.2,.02).count,1)});
test('nearest uses ordered timestamp search and handles boundaries',()=>{assert.equal(nearest([],1),null);assert.deepEqual(nearest([[1,2],[3,4]],10),[3,4]);assert.deepEqual(nearest([[1,2],[3,4]],0),[1,2])});
test('CSV quoted names, missing channels and zero values survive import',()=>{const d=parseCSV('time,joint,state,action,unit\r\n0,"finger,1",0,,rad\r\n.1,"finger,1",,0.3,rad\r\n');assert.equal(d.joints[0].name,'finger,1');assert.deepEqual(d.joints[0].state,[[0,0]]);assert.deepEqual(d.joints[0].action,[[.1,.3]])});
test('invalid data, duplicate names and units fail visibly',()=>{assert.throws(()=>parseCSV('time,joint,state\n,bad,0'));assert.throws(()=>parseCSV('time,joint,state\n0,bad,NaN'));assert.throws(()=>parseCSV('time,joint,state,unit\n0,a,1,rad\n1,a,2,deg'));assert.throws(()=>normalize({joints:[{name:'a',state:[[0,null]]}]}));assert.throws(()=>normalize({joints:[{name:'a',state:[[0,1]]},{name:'a',state:[[0,1]]}]}))});
test('normalization preserves separate action timestamps and sorts samples',()=>{const d=normalize({joints:[{name:'a',state:[[2,1],[0,2]],action:[[.1,3]]}]});assert.deepEqual(d.joints[0].state,[[0,2],[2,1]]);assert.deepEqual(d.joints[0].action,[[.1,3]]);assert.equal(d.min,0);assert.equal(d.max,2)});
test('episode diagnosis separates tracking error from missing or unpaired data', () => {
  const state = [[0, 0], [1, 0], [2, 0]];
  const dataset = normalize({ joints: [
    { name: 'normal', unit: 'rad', state, action: [[0, 0], [1, 0.01], [2, 0]] },
    { name: 'peak', unit: 'deg', state, action: [[0, 0], [1, 16], [2, 0], [3, 0], [4, 0]] },
    { name: 'mean', unit: 'rad', state, action: [[0, 0.1], [1, 0.1], [2, 0.1]] },
    { name: 'state only', unit: 'rad', state },
    { name: 'action only', unit: 'rad', action: state },
    { name: 'sparse', unit: 'rad', state, action: [[0, 0], [1, 0]] },
    { name: 'shifted', unit: 'rad', state, action: [[0.1, 0], [1.1, 0], [2.1, 0]] },
    { name: 'unknown unit', state, action: state }
  ] });

  const report = diagnoseEpisode(dataset, 0.03);
  assert.equal(report.passedCount, 1);
  assert.equal(report.highErrorCount, 2);
  assert.equal(report.incompleteCount, 5);
  const reasons = new Map(report.findings.map(joint => [joint.name, joint.reasons.join(' ')]));
  assert.match(reasons.get('peak'), /MAX 16\.00°/);
  assert.match(reasons.get('mean'), /MAE 5\.73°/);
  assert.match(reasons.get('state only'), /缺少 Action/);
  assert.match(reasons.get('action only'), /缺少 State/);
  assert.match(reasons.get('sparse'), /2\/3 个 State 样本/);
  assert.match(reasons.get('shifted'), /无有效配对/);
  assert.match(reasons.get('unknown unit'), /无法应用角度阈值/);
  assert.equal(diagnoseEpisode(dataset, 0.11).passedCount, 2);
});
