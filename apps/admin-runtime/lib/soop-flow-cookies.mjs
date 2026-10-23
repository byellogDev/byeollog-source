// A shared callback can identify only one active browser flow without returned
// state. Select that flow when starting authorization, never by relaxing state.
export function clearOtherSoopFlowCookie(res, flow, {secure = true} = {}) {
  if (!['normal', 'game'].includes(flow)) throw new Error('invalid_soop_flow');
  const cookie = flow === 'normal'
    ? 'byeollog_game_link=; Path=/api'
    : 'byeollog_soop_oauth_attempt=; Path=/api/auth/soop';
  const value = `${cookie}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=0`;
  const current = res.getHeader?.('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(current) ? current : current ? [String(current)] : []), value]);
}
