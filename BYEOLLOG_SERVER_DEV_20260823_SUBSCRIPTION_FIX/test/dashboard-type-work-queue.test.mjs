import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const source=await readFile(new URL("../lib/admin-source.html",import.meta.url),"utf8");

test("pending dashboard exposes a dedicated type-sorted shooting queue",()=>{
  assert.match(source,/id="sortTypeBtn"[^>]+setSort\('type'\)[^>]*>종류별 정렬<\/button>/);
  assert.match(source,/sortKey=k==='latest'\|\|k==='type'\?k:'fan'/);
  assert.match(source,/sortTypeBtn[^\n]+sortKey==='type'/);
  assert.match(source,/viewMode==='pending'&&sortKey==='type'/);
  assert.match(source,/renderTypeWorkQueue\(list,fileHtmlById\)/);
});

test("type queue sums remaining cuts and keeps the streamer work controls",()=>{
  const start=source.indexOf("function renderTypeWorkQueue(");
  const end=source.indexOf("\nasync function render()",start);
  assert.ok(start>=0&&end>start,"type work queue renderer is missing");
  const block=source.slice(start,end);
  assert.match(block,/totalCuts=list\.reduce\(\(sum,task\)=>sum\+remain\(task\),0\)/);
  assert.match(block,/cuts=rows\.reduce\(\(sum,task\)=>sum\+remain\(task\),0\)/);
  assert.match(block,/총 촬영 컷/);
  assert.match(block,/\$\{remain\(task\)\.toLocaleString\(\)\}컷/);
  assert.match(block,/종류별 촬영 작업표/);
  assert.match(block,/팬 \$\{fans\.toLocaleString\(\)\}명 · 작업 \$\{rows\.length\.toLocaleString\(\)\}건/);
  assert.match(block,/inlineNoteButton\(task,'public_comment'\)/);
  assert.match(block,/inlineNoteButton\(task,'memo'\)/);
  assert.match(block,/fileHtmlById\.get\(task\.id\)/);
  assert.match(block,/toggleComplete\('\$\{task\.id\}'\)/);
  assert.match(block,/openEdit\('\$\{task\.id\}'\)/);
  assert.doesNotMatch(block,/\bapi\(|\bfetch\(/,"sorting and cut totals must remain a read-only local view");
});
