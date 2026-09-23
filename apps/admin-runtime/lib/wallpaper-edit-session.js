// Shared by the browser and generated Agent editor. No DOM or transport ownership.
// A read ticket belongs to one edit generation; completing a write invalidates it.
export function createWallpaperEditSession() {
  let generation = 0;
  let active = null;
  return {
    get busy() { return active !== null; },
    begin(action) {
      if (active) throw new Error('앞선 저장을 처리하고 있습니다. 잠시 기다려주세요.');
      const ticket = {generation: ++generation, action};
      active = ticket;
      return ticket;
    },
    finish(ticket) {
      if (active === ticket) { active = null; generation++; }
    },
    readTicket() { return generation; },
    accepts(ticket, current, next) {
      if (active || ticket !== generation || !next || !Number.isSafeInteger(Number(next.revision))) return false;
      return !current || Number(next.revision) >= Number(current.revision);
    },
    invalidate() { generation++; }
  };
}

export const wallpaperEditSessionScript = `const createWallpaperEditSession=${createWallpaperEditSession.toString()};const wallpaperEditSession=createWallpaperEditSession();`;
