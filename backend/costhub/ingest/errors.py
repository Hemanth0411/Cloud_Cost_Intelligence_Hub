"""Errors that mean 'configuration is incomplete', not 'the code is wrong'.

Raised by adapters and handled without a traceback: the message carries
the fix, and a stack trace would only bury it.
"""
from __future__ import annotations


class ExpectedIngestError(Exception):
    pass


class AccessNotGranted(ExpectedIngestError):
    """The account has not granted cost access to this principal."""
