// SOOP JOIN can return an account with a numeric connection suffix, e.g.
// fixture(2), while authenticated chatinfo and socket URL use fixture.
// Normalize only that complete wire format; never use a prefix/substring match.
export function normalizeSoopRoomOwner(value){
  if(typeof value!=='string'||value.length>92)return '';
  const match=/^([a-z0-9_.-]{2,80})(?:\([0-9]{1,10}\))?$/i.exec(value);
  return match&&match[0]===value?match[1].toLowerCase():'';
}
