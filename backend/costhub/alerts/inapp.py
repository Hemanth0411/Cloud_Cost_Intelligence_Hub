"""In-app delivery: the event row itself is the notification.

More demo-able than email -- an email nobody sees on a projector proves
nothing -- and it needs no SES verification to work.
"""
from __future__ import annotations

from costhub.alerts.ports import Delivery, Event


class InAppNotifier:
    channel = "inapp"

    def send(self, event: Event, *, recipients: list[str]) -> Delivery:
        # The alert_events row is written by the runner either way; for
        # this channel that row *is* the delivery.
        return Delivery(channel=self.channel, sent=True)
