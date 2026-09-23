import assert from 'node:assert/strict';
import test from 'node:test';
import {isPotentialExternalRouletteResultMessage,parseExternalRouletteResultMessage} from '../lib/soop-external-roulette.js';

test('external roulette result parser accepts the explicit result contract',()=>{
  assert.deepEqual(parseExternalRouletteResultMessage('룰렛 결과 : 고양이 간식'),{
    resultText:'고양이 간식',rouletteName:null,donorName:null,message:'룰렛 결과 : 고양이 간식'
  });
});

test('external roulette result parser extracts a donor hint without inventing identity',()=>{
  const parsed=parseExternalRouletteResultMessage('피치후로요이님의 룰렛 결과 : 물 한 잔');
  assert.equal(parsed?.donorName,'피치후로요이');
  assert.equal(parsed?.resultText,'물 한 잔');
});

test('ordinary chat never enters the external roulette correlation path',()=>{
  for(const message of ['안녕하세요','룰렛 언제 해요?','결과가 궁금해요','룰렛 결과를 알려주세요']){
    assert.equal(isPotentialExternalRouletteResultMessage(message),false,message);
  }
});
