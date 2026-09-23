import original from '../handlers/login.js';
import {createInternalRuntimeHandler,allowAdminLogin} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'admin',allowRequest:allowAdminLogin});
