export function normalizeRouletteAmountMapping(input){
  const balloons=Number(input?.balloons);
  const rouletteName=String(input?.rouletteName||input?.roulette_name||'').trim().normalize('NFC');
  if(!Number.isSafeInteger(balloons)||balloons<1||balloons>1000000000)throw new Error('별풍선 개수는 1~1,000,000,000 사이의 정수로 입력해주세요.');
  if(!rouletteName||rouletteName.length>120)throw new Error('이벤트명은 1~120자로 입력해주세요.');
  const mapping={balloons,roulette_name:rouletteName,updated_at:new Date().toISOString()};
  if(Object.hasOwn(input,'balloonsMax')||Object.hasOwn(input,'balloons_max')){
    const max=Number(input.balloonsMax??input.balloons_max);
    if(!Number.isSafeInteger(max)||max<balloons||max>1000000000)throw new Error('최대 개수는 최소 개수 이상, 1,000,000,000개 이하로 입력해주세요.');
    mapping.balloons_max=max;
  }
  if(Object.hasOwn(input,'enabled')){
    if(typeof input.enabled!=='boolean')throw new Error('활성 상태를 다시 선택해주세요.');
    mapping.enabled=input.enabled;
  }
  // Old clients omit this column: PostgREST merge-upsert must not overwrite it.
  const hasSpins=Object.hasOwn(input,'expectedSpins')||Object.hasOwn(input,'expected_spins');
  if(hasSpins){
    const value=Object.hasOwn(input,'expectedSpins')?input.expectedSpins:input.expected_spins;
    if(value!==null&&(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>1000)){
      throw new Error('후원 1건당 회전 수는 1~1,000 사이의 정수로 입력해주세요.');
    }
    mapping.expected_spins=value;
  }
  return mapping;
}
