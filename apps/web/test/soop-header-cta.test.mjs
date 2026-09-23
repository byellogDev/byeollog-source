import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {getProductDashboardHtml} from '../lib/product-dashboard-html.js';
import {getRouletteClassificationHtml} from '../lib/roulette-classification-html.js';

test('every dashboard preserves the SOOP CTA copy and visibility across status refreshes',async()=>{
  const pages=[
    [getProductDashboardHtml('test-nonce','signatures'),'syncSoopConnection'],
    [getRouletteClassificationHtml('test-nonce'),'syncSoopConnection'],
    [await readFile(new URL('../lib/admin-source.html',import.meta.url),'utf8'),'syncSoopConnectionUi']
  ];
  for(const [page,name] of pages){
    assert.match(page,/id="soopConnectBtn"[^>]*href="\/api\/auth\/soop\/start">SOOP 계정 연결하기<\/a>/);
    const script=name==='syncSoopConnectionUi'
      ?page.match(/function syncSoopConnectionUi\(\)\{[\s\S]*?\n\}/)[0]
      :page.match(/function syncSoopConnection\(\)\{[^\n]+/)[0];
    const nodes=new Map();
    const $=id=>{
      if(!nodes.has(id)){
        const classes=new Set();
        nodes.set(id,{textContent:'',style:{},classList:{toggle(key,on){on?classes.add(key):classes.delete(key)},contains:key=>classes.has(key)}});
      }
      return nodes.get(id);
    };
    const context=vm.createContext({$,state:{},soopConnectionState:null,formatSoopDate:()=>'',formatSoopConnectionDate:()=>''});
    vm.runInContext(script,context);
    for(let repeat=0;repeat<3;repeat++){
      for(const [data,hidden,label] of [
        [{enabled:true,configured:true,connected:false},false,'SOOP 계정 연결하기'],
        [{enabled:true,configured:true,connected:true},true,'SOOP 계정 연결하기'],
        [{enabled:true,configured:true,connected:false,status:'reauthorization_required'},false,'SOOP 계정 다시 연결하기'],
        [{enabled:false,configured:false,connected:false},true,'SOOP 계정 연결하기']
      ]){
        context.state.soop=data;context.soopConnectionState=data;
        vm.runInContext(name+'()',context);
        assert.equal($('soopConnectBtn').textContent,label,name);
        assert.equal($('soopConnectBtn').classList.contains('hidden'),hidden,name);
      }
    }
  }
});
