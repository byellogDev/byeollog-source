import importlib.util, pathlib, unittest
spec=importlib.util.spec_from_file_location('compare',pathlib.Path(__file__).with_name('soak-compare.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
Comparison=module.Comparison
def frame(at=2000,digest='same',code=5):return {'at':at,'digest':digest,'code':code}

class CompareTests(unittest.TestCase):
    def test_reordered_and_repeated_messages_match_as_multiset(self):
        c=Comparison(0)
        c.add('original',frame());c.add('original',frame(2100))
        c.add('candidate',frame(2050));c.add('candidate',frame(2110))
        self.assertEqual(c.summary()['matched'],{'5':2});self.assertEqual(c.pending_count,0)
    def test_different_accounts_cannot_cancel_each_others_mismatch(self):
        a,b=Comparison(0),Comparison(0)
        a.add('original',frame(digest='account_a'));a.add('candidate',frame(digest='account_b'))
        b.add('original',frame(digest='account_b'));b.add('candidate',frame(digest='account_a'))
        for c in [a,b]:c.expire(13000);self.assertTrue(c.mismatched());self.assertEqual(c.summary()['matched'],{})
    def test_duplicate_in_one_path_is_detected(self):
        c=Comparison(0);c.add('original',frame());c.add('candidate',frame());c.add('candidate',frame())
        c.expire(13000);self.assertEqual(c.summary()['only']['candidate'],{'5':1})
    def test_start_end_margins_are_explicit(self):
        c=Comparison(1000);c.add('original',frame(1999));c.add('original',frame(3000));c.add('candidate',frame(4600))
        c.expire(5000,final=True)
        self.assertEqual(c.summary()['matched'],{'5':1});self.assertFalse(c.mismatched())
    def test_bounded_on_silent_counterpart(self):
        c=Comparison(0,limit=2)
        c.add('original',frame());c.add('original',frame())
        with self.assertRaisesRegex(ValueError,'capacity'):c.add('original',frame())
    def test_donation_and_chat_do_not_match_each_other(self):
        c=Comparison(0);c.add('original',frame(code=18));c.add('candidate',frame(code=5));c.expire(13000)
        self.assertTrue(c.mismatched())

if __name__=='__main__':unittest.main()
