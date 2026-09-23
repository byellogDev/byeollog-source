import {createRuntimeProxyHandler} from '../lib/runtime-proxy.js';
import {selectLoginRuntime} from '../lib/runtime-isolation.js';
const loginProxy=createRuntimeProxyHandler({chooseRuntime:selectLoginRuntime,endpoint:'/api/login'});
const gameLinkProxy=createRuntimeProxyHandler({runtime:'admin',endpoint:'/api/game-link'});
const minecraftServerProxy=createRuntimeProxyHandler({runtime:'admin',endpoint:'/api/minecraft-server'});
export default function handler(req,res){
  const operation=String(req.query?.operation||'');
  if(operation.startsWith('game-link-')){
    req.query={...req.query,operation:operation.slice('game-link-'.length)};
    return gameLinkProxy(req,res);
  }
  if(operation.startsWith('minecraft-server-')){
    req.query={...req.query,operation:operation.slice('minecraft-server-'.length)};
    return minecraftServerProxy(req,res);
  }
  return loginProxy(req,res);
}
