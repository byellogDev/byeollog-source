// Synthetic protocol fixtures. No captured user traffic or credentials.
export const configFor=(id='lab0')=>({broadcasterId:id,accessToken:'synthetic-token-'+id,clientId:'synthetic-client',clientSecret:'synthetic-secret',durationMs:1000});
export const infoFor=(id='lab0')=>({result:1,data:[{id,chat_ip:'127.0.0.1',chat_port:8000,chat_no:1000,broad_no:100,nick:'합성방송자',key:'synthetic-ticket-'+id,title:'synthetic',broad_type:'21'}]});
export const fixtures=(id='lab0')=>[
  {name:'chat',code:5,fields:['룰렛 결과: 꽝\r\n확인','synthetic-user','0','','','합성시청자','0|0','0','','','0']},
  {name:'manager',code:26,fields:['관리자 채팅','synthetic-user','0','','합성시청자','0|0','0']},
  {name:'balloon',code:18,fields:[id,'synthetic-user','합성시청자','100','1','0','1000','','0','1','']},
  {name:'custom-balloon',code:18,fields:[id,'synthetic-user','합성시청자','33','1','0','1000','synthetic','0','1','']},
  {name:'relay-balloon',code:33,fields:['',id,'','synthetic-user','합성시청자','33','1','','synthetic','0']},
  {name:'vod-balloon',code:86,fields:[id,'synthetic-user','합성시청자','10']},
  {name:'video',code:105,fields:['',id,'synthetic-user','합성시청자','100','1','','0','0']},
  {name:'ad-live',code:87,fields:['',id,'synthetic-user','합성시청자','','','광고','','https://res.sooplive.com/synthetic.png','10','1','','0','0']},
  {name:'ad-vod',code:103,fields:[id,'synthetic-user','합성시청자','10','https://res.sooplive.com/synthetic.png','광고']},
  {name:'ad-station',code:107,fields:[id,'synthetic-user','합성시청자','10','https://res.sooplive.com/synthetic.png','광고']},
  ...['GIFT','CHALLENGE_GIFT'].map(type=>({name:type,code:121,fields:[JSON.stringify({type,user_id:'synthetic-user',user_nick:'합성시청자',gift_count:100,image:'synthetic',is_relay:false,fan_order:1})]})),
  {name:'ogq-chat',code:109,fields:['','이모티콘 채팅','synthetic','1','1','synthetic-user','합성시청자','0|0','0','','','png']}
];
