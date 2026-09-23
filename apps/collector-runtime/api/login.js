import original from '../handlers/login.js';
import {createInternalRuntimeHandler,allowCollectorLogin} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'collector',allowRequest:allowCollectorLogin});
