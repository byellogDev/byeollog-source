export default async function handler(_req,res){
  res.setHeader('Cache-Control','no-store, private');
  return res.status(410).json({message:'Weflab Collector 연결 기능은 종료되었습니다.',code:'legacy_weflab_collector_retired'});
}
