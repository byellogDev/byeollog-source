import original from '../handlers/native-roulette.js';
import {createInternalRuntimeHandler,allowAdminNativeRoulette} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'admin',allowRequest:allowAdminNativeRoulette});
