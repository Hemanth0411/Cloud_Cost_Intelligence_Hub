"""Email delivery via SES.

Never raises: a failed send is returned as a Delivery so the event is
still recorded with its error. Losing the record of an alert that fired
is worse than failing to send it.
"""
from __future__ import annotations

import logging

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from costhub.alerts.ports import Delivery, Event
from costhub.config import settings

log = logging.getLogger(__name__)


class SesNotifier:
    channel = "email"

    def __init__(self, sender: str | None = None, region: str | None = None) -> None:
        self.sender = sender or settings().ses_sender_email
        self.region = region or settings().aws_region
        self._client = None

    @property
    def client(self):
        if self._client is None:
            self._client = boto3.client("ses", region_name=self.region)
        return self._client

    def send(self, event: Event, *, recipients: list[str]) -> Delivery:
        if not self.sender:
            return Delivery(self.channel, False, "SES_SENDER_EMAIL not configured")
        if not recipients:
            return Delivery(self.channel, False, "no recipients")

        try:
            self.client.send_email(
                Source=self.sender,
                Destination={"ToAddresses": recipients},
                Message={
                    "Subject": {"Data": event.subject[:200]},
                    "Body": {"Text": {"Data": event.body}},
                },
            )
        except (ClientError, BotoCoreError) as exc:
            # In the SES sandbox every recipient must be verified first,
            # which is the usual cause here.
            log.warning("ses send failed: %s", exc)
            return Delivery(self.channel, False, str(exc)[:500])

        return Delivery(self.channel, True)
