"""Offline regressions for Dev acceptance; never starts Lake or a provider."""
import unittest
from unittest.mock import Mock, patch

from test_strategy_learning_dev import Lake


class DevTurnWaitTests(unittest.TestCase):
    def lake(self, snapshots):
        lake = Lake.__new__(Lake)
        lake.snapshot = Mock(side_effect=snapshots)
        lake.api = Mock(return_value={'id': 'accepted-message'})
        return lake

    def test_queued_message_cannot_pass_from_previous_completed_answer(self):
        old = {'rootTurnId': 'old', 'status': 'completed', 'cards': ['old answer']}
        new = {'rootTurnId': 'new', 'status': 'completed', 'cards': ['new answer']}
        lake = self.lake([old, old, {'rootTurnId': 'new', 'status': 'running'}, new])
        with patch('test_strategy_learning_dev.time.sleep'):
            self.assertEqual(lake.send_and_finish('session', 'next message'), new)
        lake.api.assert_called_once_with('/api/sessions/session/messages', 'POST', {'text': 'next message'})
        self.assertEqual(lake.snapshot.call_count, 4)

    def test_fast_new_terminal_failure_is_retained_without_retry(self):
        failed = {'rootTurnId': 'new', 'status': 'failed'}
        lake = self.lake([{'rootTurnId': 'old', 'status': 'completed'}, failed])
        self.assertEqual(lake.send_and_finish('session', 'next message'), failed)
        self.assertEqual(lake.api.call_count, 1)

    def test_old_terminal_or_missing_identity_times_out_without_redispatch(self):
        for response in ({'rootTurnId': 'old', 'status': 'completed'}, {'status': 'completed'}):
            with self.subTest(response=response):
                lake = self.lake([])
                lake.snapshot.side_effect = None
                lake.snapshot.return_value = response
                with patch('test_strategy_learning_dev.time.monotonic', side_effect=[0, 0, 71]), patch('test_strategy_learning_dev.time.sleep'):
                    with self.assertRaises(TimeoutError):
                        lake.send_and_finish('session', 'next message')
                self.assertEqual(lake.api.call_count, 1)

    def test_new_approval_is_not_a_success(self):
        lake = self.lake([{'rootTurnId': '', 'status': 'idle'}, {'rootTurnId': 'new', 'status': 'waiting_approval'}])
        with self.assertRaisesRegex(AssertionError, 'unexpected approval'):
            lake.send_and_finish('session', 'readonly fixture')
        self.assertEqual(lake.api.call_count, 1)

    def test_finish_current_turn_still_supports_abort_recovery(self):
        cancelled = {'rootTurnId': 'same', 'status': 'cancelled'}
        lake = self.lake([cancelled])
        self.assertEqual(lake.finish('session'), cancelled)
        lake.api.assert_not_called()


if __name__ == '__main__':
    unittest.main()
