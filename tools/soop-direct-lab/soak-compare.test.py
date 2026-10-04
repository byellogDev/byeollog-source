import importlib.util,pathlib,unittest,json
spec=importlib.util.spec_from_file_location('compare',pathlib.Path(__file__).with_name('soak-compare.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def frame(at=2000,digest='a',raw='a',code=18):
 return {'schema':2,'at':at,'code':code,'digest':digest*64,'rawDigest':raw*64,'semanticKind':'event',
         'fields':[{'digest':raw*64,'bytes':3}], 'business':{'event.message.count':{'digest':digest*64,'bytes':3}}}
class CompareTests(unittest.TestCase):
 def test_wire_only_difference_is_not_failure_but_persisted(self):
  records=[];c=m.Comparison(0,on_diagnostic=records.append)
  c.add('original',frame());c.add('candidate',frame(2001,raw='b'));c.expire(20000)
  self.assertFalse(c.mismatched());self.assertEqual(c.matched,{'18':1})
  self.assertEqual(records[0]['wireFields'],[0]);self.assertEqual(records[0]['businessFields'],[])
  self.assertEqual(c.summary()['rawDifferenceCounts'],{'18':1})
 def test_business_difference_has_two_sides_and_named_fields(self):
  records=[];c=m.Comparison(0,on_diagnostic=records.append)
  c.add('original',frame());c.add('candidate',frame(2001,digest='b',raw='b'));c.expire(20000)
  self.assertTrue(c.mismatched());self.assertEqual(len(records),2)
  self.assertEqual(records[0]['businessFields'],['event.message.count']);self.assertEqual(records[0]['pairing'],'time_proximity_not_identity')
 def test_identical_repeats_preserve_multiplicity_and_duplicate_fails(self):
  c=m.Comparison(0)
  for t in [2000,2100]:c.add('original',frame(t));c.add('candidate',frame(t+1,raw='b'))
  c.add('candidate',frame(2200));c.expire(20000)
  self.assertEqual(c.matched,{'18':2});self.assertEqual(c.only['candidate'],{'18':1})
 def test_missing_counterpart_is_not_hidden(self):
  c=m.Comparison(0);c.add('original',frame());c.expire(20000)
  self.assertTrue(c.mismatched());self.assertIsNone(c.summary()['diagnosticExamples'][0]['possiblePeer'])
 def test_ignored_packets_cannot_pass_initial_content_gate(self):
  c=m.Comparison(0);f=frame();f['semanticKind']='ignored';c.add('original',f);c.add('candidate',f)
  self.assertEqual(c.matched,{});self.assertEqual(c.ignored,{'18':1})
 def test_legacy_records_and_untrusted_diagnostics_are_rejected_or_stripped(self):
  c=m.Comparison(0)
  with self.assertRaisesRegex(ValueError,'schema'):c.add('original',{'at':2000,'code':18,'digest':'a'*64})
  f=frame();f['accessToken']='private-marker';self.assertNotIn('private-marker',json.dumps(m.safe_record(f)))
  f['business']['private-marker']={'digest':'a'*64,'bytes':1}
  with self.assertRaisesRegex(ValueError,'invalid'):m.safe_record(f)
 def test_capacity_and_time_window_fail_closed(self):
  c=m.Comparison(0,limit=1);c.add('original',frame())
  with self.assertRaisesRegex(ValueError,'capacity'):c.add('original',frame())
  c=m.Comparison(0);c.add('original',frame());c.add('candidate',frame(12001));c.expire(30000)
  self.assertTrue(c.mismatched());self.assertEqual(c.matched,{})
 def test_session_scopes_and_event_kinds_cannot_cancel(self):
  c=m.Comparison(0);c.add('original',frame());c.add('candidate',frame(digest='b'));c.expire(20000)
  self.assertTrue(c.mismatched())
  c=m.Comparison(0);c.add('original',frame());c.add('candidate',frame(code=5));c.expire(20000)
  self.assertTrue(c.mismatched())
if __name__=='__main__':unittest.main()
