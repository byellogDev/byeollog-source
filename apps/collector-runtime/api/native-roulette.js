import original from '../handlers/native-roulette.js';
import {createInternalRuntimeHandler,allowCollectorNativeRoulette} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'collector',allowRequest:allowCollectorNativeRoulette});
