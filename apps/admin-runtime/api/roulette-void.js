import original from '../handlers/roulette-void.js';
import {createInternalRuntimeHandler} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'admin',allowRequest:()=>true});
