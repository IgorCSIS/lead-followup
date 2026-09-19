"""Draft same-day SMS and email replies for a CSV of remodeling leads.

This is the command line twin of the browser tool in ``src/``. The web app is
the single source of truth for the wording: ``src/lib/drafts.ts`` defines the
templates, and this module mirrors them so both produce byte-identical
drafts. ``scripts/check-parity.mjs`` compares the two on the sample file and
fails the build if they ever drift, so a template change has to be made in
both places or the build goes red.

Nothing here touches the network. There is no API key, no model call, and no
send step: the tool writes drafts and a person sends them.

Example
-------
    python tools/lead_followup_drafter.py
    python tools/lead_followup_drafter.py --csv leads.csv --only-urgent

Style follows Appendix A: snake_case names, ALL_CAPS constants marked
``Final``, a leading underscore on anything private, and a docstring on every
module, class, and function.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final, Iterable, Iterator, Mapping, Sequence

# ---------------------------------------------------------------------------
# Constants
#
# Every one of these mirrors a constant in src/lib/drafts.ts. The mappings are
# wrapped in MappingProxyType so a caller cannot mutate the templates at
# runtime and silently break parity with the web app.
# ---------------------------------------------------------------------------

#: Timeline answers that mean the homeowner wants to hear back today rather
#: than whenever someone gets to it. Compared lower-cased.
URGENT_TIMELINES: Final[frozenset[str]] = frozenset(
    {
        'asap',
        'as soon as possible',
        'emergency',
        'immediately',
        'urgent',
    }
)

#: Opening line per project type. Naming the specific job in the first
#: sentence is what makes a reply read as written by a person.
PROJECT_OPENERS: Final[Mapping[str, str]] = MappingProxyType(
    {
        'kitchen': 'Thanks for the details on the kitchen.',
        'kitchen remodel': 'Thanks for the details on the kitchen.',
        'bathroom': 'Thanks for the details on the bathroom.',
        'bathroom remodel': 'Thanks for the details on the bathroom.',
        'adu': 'Thanks for reaching out about the ADU.',
        'adu or garage conversion': 'Thanks for reaching out about the ADU.',
        'garage conversion': 'Thanks for reaching out about the garage conversion.',
        'whole home': 'Thanks for reaching out about the whole-home remodel.',
        'whole-home remodel': 'Thanks for reaching out about the whole-home remodel.',
    }
)

#: Used when the project type is blank or not one we have a line for.
GENERIC_OPENER: Final[str] = 'Thanks for reaching out about your project.'

#: Short project nouns for the text message. The SMS cannot afford the full
#: opener sentence: a realistic worst case (an eleven-letter first name, a
#: whole-home remodel, a long timeline) ran to 178 characters with it, which
#: carriers split into two messages. Naming the job in three words instead of
#: a sentence buys back the room while still reading as written by a person.
PROJECT_LABELS: Final[Mapping[str, str]] = MappingProxyType(
    {
        'kitchen': 'kitchen',
        'kitchen remodel': 'kitchen',
        'bathroom': 'bathroom',
        'bathroom remodel': 'bathroom',
        'adu': 'ADU',
        'adu or garage conversion': 'ADU',
        'garage conversion': 'garage conversion',
        'whole home': 'whole-home remodel',
        'whole-home remodel': 'whole-home remodel',
    }
)

#: Used when the project type is blank or not one we have a label for.
GENERIC_PROJECT_LABEL: Final[str] = 'project'

#: How soon to offer a visit, per timeline. These are deliberately
#: conservative: the promise has to be one the business can actually keep.
#: They are also kept short, because the same line goes into the text message
#: and every character there counts against the single-message limit.
VISIT_OFFERS: Final[Mapping[str, str]] = MappingProxyType(
    {
        'asap': 'I can come take a look tomorrow if that works.',
        'as soon as possible': 'I can come take a look tomorrow if that works.',
        '1-3 months': 'I can come take a look this week or next.',
        '1 to 3 months': 'I can come take a look this week or next.',
        '3-6 months': 'Happy to come walk the space whenever you are ready.',
        '3 to 6 months': 'Happy to come walk the space whenever you are ready.',
        '6-12 months': 'Happy to come out and get you a number to plan with.',
        '6 months or later': 'Happy to come out and get you a number to plan with.',
        'just planning': 'Happy to give you a ballpark whenever you want one.',
        'just researching': 'Happy to give you a ballpark whenever you want one.',
        'still planning': 'Happy to give you a ballpark whenever you want one.',
    }
)

#: Used when the timeline is blank or not one we have an offer for.
GENERIC_VISIT_OFFER: Final[str] = 'Happy to come take a look whenever suits you.'

#: Carriers split anything longer than this into multiple messages, which
#: looks careless. Drafts over it are flagged rather than truncated, because
#: silently cutting a message is worse than showing a warning.
SMS_CHARACTER_LIMIT: Final[int] = 160

#: Accepted header spellings per field, already normalized. Order matters:
#: the first alias found in the file wins, so the canonical name is first.
FIELD_ALIASES: Final[Mapping[str, tuple[str, ...]]] = MappingProxyType(
    {
        'name': ('name', 'fullname', 'yourname', 'contact', 'contactname', 'customer', 'leadname'),
        'phone': ('phone', 'phonenumber', 'mobile', 'cell', 'tel', 'telephone', 'bestnumbertoreachyou'),
        'email': ('email', 'emailaddress', 'e mail'),
        'project_type': ('projecttype', 'project', 'service', 'jobtype', 'whatareyouremodeling', 'whatdoyouneed'),
        'city': ('city', 'cityorzip', 'town', 'location', 'zip', 'zipcode', 'postalcode', 'area'),
        'timeline': ('timeline', 'when', 'startdate', 'timeframe', 'whenwouldyouliketostart', 'urgency'),
        'details': ('details', 'projectdetails', 'message', 'notes', 'description', 'tellusabouttheproject', 'comments'),
        'source': ('source', 'howtheyheard', 'howdidyouhearaboutus', 'referral', 'channel', 'leadsource'),
        'submitted_at': ('submittedat', 'submitted', 'date', 'timestamp', 'created', 'createdat', 'receivedat'),
    }
)

#: Characters stripped from a header before matching it against an alias.
_HEADER_NOISE: Final[re.Pattern[str]] = re.compile(r'[\s_\-.]')

#: The sample file that ships with the repo, used when --csv is not given.
DEFAULT_CSV_PATH: Final[Path] = Path(__file__).resolve().parent.parent / 'public' / 'sample_leads.csv'

#: Process exit codes.
EXIT_OK: Final[int] = 0
EXIT_ERROR: Final[int] = 1


class LeadFollowupError(Exception):
    """Base class for every error this tool raises on purpose.

    Having one base class lets ``main`` catch the tool's own failures and
    print a short message, while a genuine bug still escapes as a traceback.
    """


class LeadFileError(LeadFollowupError):
    """Raised when the lead file is missing, unreadable, or has no usable rows."""


class Lead:
    """One homeowner enquiry, as read from a row of the CSV.

    A lead is a value object: it is built once from a row and never changed
    afterwards, so every attribute is private with a read-only property and
    there are no setters. That keeps a draft reproducible, because nothing
    can edit the lead between building two drafts from it.
    """

    __slots__ = (
        '_name',
        '_phone',
        '_email',
        '_project_type',
        '_city',
        '_timeline',
        '_details',
        '_source',
        '_submitted_at',
    )

    def __init__(
        self,
        name: str = '',
        phone: str = '',
        email: str = '',
        project_type: str = '',
        city: str = '',
        timeline: str = '',
        details: str = '',
        source: str = '',
        submitted_at: str = '',
    ) -> None:
        """Build a lead, trimming every field.

        Parameters
        ----------
        name, phone, email, project_type, city, timeline, details, source,
        submitted_at : str
            Raw cell values. Each is stripped of surrounding whitespace,
            because a leading space in an export would otherwise end up in
            the middle of a sentence in the draft.
        """
        self._name = name.strip()
        self._phone = phone.strip()
        self._email = email.strip()
        self._project_type = project_type.strip()
        self._city = city.strip()
        self._timeline = timeline.strip()
        self._details = details.strip()
        self._source = source.strip()
        self._submitted_at = submitted_at.strip()

    @property
    def name(self) -> str:
        """str: The homeowner's full name, possibly empty."""
        return self._name

    @property
    def phone(self) -> str:
        """str: The homeowner's phone number, possibly empty."""
        return self._phone

    @property
    def email(self) -> str:
        """str: The homeowner's email address, possibly empty."""
        return self._email

    @property
    def project_type(self) -> str:
        """str: What they want built, as they described it."""
        return self._project_type

    @property
    def city(self) -> str:
        """str: The city or area the job is in."""
        return self._city

    @property
    def timeline(self) -> str:
        """str: When they want to start, as they answered it."""
        return self._timeline

    @property
    def details(self) -> str:
        """str: Whatever they typed in the free-text box."""
        return self._details

    @property
    def source(self) -> str:
        """str: How they found the business."""
        return self._source

    @property
    def submitted_at(self) -> str:
        """str: When the enquiry arrived, as the export spelled it."""
        return self._submitted_at

    @property
    def is_contactable(self) -> bool:
        """bool: Whether there is any way to reply to this lead.

        A row with no name, phone, or email is a blank line or a footer, and
        drafting a reply to it would waste the contractor's time.
        """
        return bool(self._name or self._phone or self._email)

    @property
    def is_urgent(self) -> bool:
        """bool: Whether the timeline means this needs a reply today."""
        return self._timeline.lower() in URGENT_TIMELINES

    @property
    def first_name(self) -> str:
        """str: The first word of the name, for the greeting.

        Falls back to ``there`` when the name is missing, so a greeting never
        reads ``Hi ,``.
        """
        name = self._name or 'there'
        return name.split()[0]

    def __str__(self) -> str:
        """Return a one-line summary for logs and error messages."""
        who = self._name or self._email or self._phone or 'unnamed lead'
        what = self._project_type or 'unspecified project'
        return f'{who} ({what}, {self._timeline or "no timeline"})'

    def __repr__(self) -> str:
        """Return an unambiguous form for debugging."""
        return f'Lead(name={self._name!r}, project_type={self._project_type!r})'


class Business:
    """The company the drafts are written as.

    Unlike :class:`Lead` this is mutable, because the point of the white-label
    panel in the web app is that the contractor edits it. The setters validate
    rather than trust: an empty company name would produce a draft signed by
    nobody, which is worse than refusing to build it.
    """

    __slots__ = ('_company_name', '_owner_name', '_phone')

    def __init__(self, company_name: str, owner_name: str, phone: str) -> None:
        """Build a business identity.

        Parameters
        ----------
        company_name : str
            The name the email is signed with.
        owner_name : str
            The person the message comes from.
        phone : str
            The callback number printed in the email.

        Raises
        ------
        ValueError
            If any field is blank once stripped.
        """
        self.company_name = company_name
        self.owner_name = owner_name
        self.phone = phone

    @staticmethod
    def _require_text(value: str, field: str) -> str:
        """Return ``value`` stripped, or raise if there is nothing left.

        Parameters
        ----------
        value : str
            The candidate value.
        field : str
            The field name, used in the error message.

        Returns
        -------
        str
            The stripped value.

        Raises
        ------
        ValueError
            If the stripped value is empty.
        """
        cleaned = value.strip()
        if not cleaned:
            raise ValueError(f'{field} cannot be blank')
        return cleaned

    @property
    def company_name(self) -> str:
        """str: The company name. Setting it to blank raises ``ValueError``."""
        return self._company_name

    @company_name.setter
    def company_name(self, value: str) -> None:
        self._company_name = self._require_text(value, 'company_name')

    @property
    def owner_name(self) -> str:
        """str: The sender's name. Setting it to blank raises ``ValueError``."""
        return self._owner_name

    @owner_name.setter
    def owner_name(self, value: str) -> None:
        self._owner_name = self._require_text(value, 'owner_name')

    @property
    def phone(self) -> str:
        """str: The callback number. Setting it to blank raises ``ValueError``."""
        return self._phone

    @phone.setter
    def phone(self, value: str) -> None:
        self._phone = self._require_text(value, 'phone')

    def __str__(self) -> str:
        """Return the business as it would be introduced on the phone."""
        return f'{self._owner_name} at {self._company_name} ({self._phone})'

    def __repr__(self) -> str:
        """Return an unambiguous form for debugging."""
        return (
            f'Business(company_name={self._company_name!r}, '
            f'owner_name={self._owner_name!r}, phone={self._phone!r})'
        )


#: Default business identity, matching the Ridgeview demo brand. The number is
#: a fictional 555 line for the demo, not a real one.
DEMO_BUSINESS: Final[Business] = Business(
    company_name='Ridgeview Remodeling',
    owner_name='Marcus',
    phone='(619) 555-0180',
)


class Draft:
    """A finished SMS and email pair for one lead.

    Built by :class:`DraftWriter` and read-only afterwards, so the text a
    caller inspects is exactly the text that was generated.
    """

    __slots__ = ('_lead', '_sms', '_subject', '_body')

    def __init__(self, lead: Lead, sms: str, subject: str, body: str) -> None:
        """Store a generated draft.

        Parameters
        ----------
        lead : Lead
            The lead the draft replies to.
        sms : str
            The short text message.
        subject : str
            The email subject line.
        body : str
            The email body.
        """
        self._lead = lead
        self._sms = sms
        self._subject = subject
        self._body = body

    @property
    def lead(self) -> Lead:
        """Lead: The lead this draft replies to."""
        return self._lead

    @property
    def sms(self) -> str:
        """str: The text message to send."""
        return self._sms

    @property
    def sms_length(self) -> int:
        """int: Length of the text message in characters."""
        return len(self._sms)

    @property
    def sms_over_limit(self) -> bool:
        """bool: Whether the text would be split into multiple messages."""
        return self.sms_length > SMS_CHARACTER_LIMIT

    @property
    def subject(self) -> str:
        """str: The email subject line."""
        return self._subject

    @property
    def body(self) -> str:
        """str: The email body."""
        return self._body

    @property
    def is_urgent(self) -> bool:
        """bool: Whether this lead needs a reply today."""
        return self._lead.is_urgent

    def to_dict(self) -> dict[str, Any]:
        """Return the draft as plain data, using the web app's field names.

        The keys are camelCase on purpose. This is the wire format that
        ``scripts/check-parity.mjs`` compares against the TypeScript engine's
        output, so it has to match ``src/lib/drafts.ts`` exactly rather than
        follow Python naming. Every other name in this module stays snake_case.

        Returns
        -------
        dict
            A JSON-serializable view of the draft.
        """
        return {
            'lead': {
                'name': self._lead.name,
                'phone': self._lead.phone,
                'email': self._lead.email,
                'projectType': self._lead.project_type,
                'city': self._lead.city,
                'timeline': self._lead.timeline,
                'details': self._lead.details,
                'source': self._lead.source,
                'submittedAt': self._lead.submitted_at,
            },
            'isUrgent': self.is_urgent,
            'sms': self._sms,
            'smsLength': self.sms_length,
            'smsOverLimit': self.sms_over_limit,
            'subject': self._subject,
            'body': self._body,
        }

    def __str__(self) -> str:
        """Return the draft as it is printed to the terminal."""
        flag = 'REPLY TODAY' if self.is_urgent else 'standard'
        over = '  (over the single-message limit)' if self.sms_over_limit else ''
        contact = ' | '.join(part for part in (self._lead.phone, self._lead.email) if part)
        return (
            f'{self._lead}\n'
            f'  {flag}{("  |  " + contact) if contact else ""}\n'
            f'\n'
            f'  TEXT ({self.sms_length} characters){over}\n'
            f'  {self._sms}\n'
            f'\n'
            f'  EMAIL: {self._subject}\n'
            + '\n'.join(f'  {line}' for line in self._body.split('\n'))
        )

    def __repr__(self) -> str:
        """Return an unambiguous form for debugging."""
        return f'Draft(lead={self._lead!r}, sms_length={self.sms_length})'


class LeadSource(ABC):
    """A place leads can be read from.

    Abstract so the drafting code depends on the idea of a lead source rather
    than on CSV specifically. A future source (a pasted table, a JSON export)
    only has to implement :meth:`read_leads` and everything downstream works
    unchanged.
    """

    @abstractmethod
    def read_leads(self) -> list[Lead]:
        """Return every contactable lead from this source.

        Returns
        -------
        list of Lead
            The leads, in the order the source lists them.

        Raises
        ------
        LeadFileError
            If the source cannot be read.
        """

    @property
    @abstractmethod
    def description(self) -> str:
        """str: A short human-readable name for the source, used in output."""

    def __str__(self) -> str:
        """Return the source description."""
        return self.description


class CsvLeadSource(LeadSource):
    """Leads read from a CSV file.

    Real exports never have the headers you expect. A Web3Forms export, a
    Google Sheet a contractor maintains by hand, and a CRM download all call
    the same column something different, so every field accepts a list of
    aliases and matching ignores case, spaces, underscores, hyphens and dots.
    """

    __slots__ = ('_path', '_skipped_rows', '_missing_fields', '_unmapped_headers')

    def __init__(self, path: Path) -> None:
        """Point the source at a file.

        Parameters
        ----------
        path : Path
            The CSV file to read. It is not opened until
            :meth:`read_leads` is called.
        """
        self._path = path
        self._skipped_rows = 0
        self._missing_fields: list[str] = []
        self._unmapped_headers: list[str] = []

    @property
    def path(self) -> Path:
        """Path: The file this source reads."""
        return self._path

    @property
    def description(self) -> str:
        """str: The file name, for printing."""
        return str(self._path)

    @property
    def skipped_rows(self) -> int:
        """int: Rows dropped for having no name, phone, or email.

        Zero until :meth:`read_leads` has run.
        """
        return self._skipped_rows

    @property
    def missing_fields(self) -> tuple[str, ...]:
        """tuple of str: Canonical fields no column could be matched to."""
        return tuple(self._missing_fields)

    @property
    def unmapped_headers(self) -> tuple[str, ...]:
        """tuple of str: Headers in the file that were not recognized."""
        return tuple(self._unmapped_headers)

    @staticmethod
    def _normalize_header(header: str) -> str:
        """Strip everything that varies between exports of the same column.

        Parameters
        ----------
        header : str
            A header cell as written in the file.

        Returns
        -------
        str
            The header lower-cased with spaces, underscores, hyphens and dots
            removed, ready to compare against :data:`FIELD_ALIASES`.
        """
        return _HEADER_NOISE.sub('', header.lower())

    def _map_headers(self, headers: Sequence[str]) -> dict[str, str]:
        """Work out which column feeds which lead field.

        Also records the fields that went unmatched and the headers that went
        unused, so the caller can tell the contractor what was ignored instead
        of silently dropping their data.

        Parameters
        ----------
        headers : sequence of str
            The header row, already trimmed.

        Returns
        -------
        dict
            A mapping of original header to canonical field name.
        """
        normalized: dict[str, str] = {}
        for header in headers:
            normalized[self._normalize_header(header)] = header

        mapping: dict[str, str] = {}
        claimed: set[str] = set()
        self._missing_fields = []

        for field, aliases in FIELD_ALIASES.items():
            hit = next((alias for alias in aliases if alias in normalized), None)
            if hit is None:
                self._missing_fields.append(field)
                continue
            original = normalized[hit]
            mapping[original] = field
            claimed.add(original)

        self._unmapped_headers = [h for h in headers if h not in claimed and h.strip()]
        return mapping

    def read_leads(self) -> list[Lead]:
        """Read and parse the file.

        Returns
        -------
        list of Lead
            Every row that has at least one way to contact the person.

        Raises
        ------
        LeadFileError
            If the file is missing, unreadable, or has no header row.
        """
        try:
            text = self._path.read_text(encoding='utf-8-sig')
        except FileNotFoundError as error:
            raise LeadFileError(f'No lead file at {self._path}') from error
        except OSError as error:
            raise LeadFileError(f'Could not read {self._path}: {error}') from error
        except UnicodeDecodeError as error:
            raise LeadFileError(
                f'{self._path} is not UTF-8 text. Re-export it as CSV UTF-8.'
            ) from error

        reader = csv.DictReader(text.splitlines())
        if reader.fieldnames is None:
            raise LeadFileError(f'{self._path} has no header row')

        headers = [name.strip() for name in reader.fieldnames]
        mapping = self._map_headers(headers)

        self._skipped_rows = 0
        leads: list[Lead] = []
        for row in reader:
            values = {
                field: (row.get(original) or '')
                for original, field in mapping.items()
            }
            lead = Lead(**values)
            if not lead.is_contactable:
                self._skipped_rows += 1
                continue
            leads.append(lead)
        return leads


class DraftWriter:
    """Turns leads into drafts for one business.

    Holding the business here rather than passing it to every call means a
    caller cannot accidentally write half a batch as one company and half as
    another.
    """

    __slots__ = ('_business',)

    def __init__(self, business: Business) -> None:
        """Bind the writer to a business identity.

        Parameters
        ----------
        business : Business
            Who the drafts are written as.
        """
        self._business = business

    @property
    def business(self) -> Business:
        """Business: The identity the drafts are written as."""
        return self._business

    @staticmethod
    def _label_for(lead: Lead) -> str:
        """Choose the short project noun for a lead, for the text message.

        Parameters
        ----------
        lead : Lead
            The lead being replied to.

        Returns
        -------
        str
            A two or three word name for the job, or the generic label.
        """
        return PROJECT_LABELS.get(lead.project_type.lower(), GENERIC_PROJECT_LABEL)

    @staticmethod
    def _opener_for(lead: Lead) -> str:
        """Choose the opening sentence for a lead's project type, for the email.

        Parameters
        ----------
        lead : Lead
            The lead being replied to.

        Returns
        -------
        str
            A project-specific opener, or the generic one.
        """
        return PROJECT_OPENERS.get(lead.project_type.lower(), GENERIC_OPENER)

    @staticmethod
    def _visit_offer_for(lead: Lead) -> str:
        """Choose the visit offer that matches a lead's timeline.

        Parameters
        ----------
        lead : Lead
            The lead being replied to.

        Returns
        -------
        str
            A timeline-specific offer, or the generic one.
        """
        return VISIT_OFFERS.get(lead.timeline.lower(), GENERIC_VISIT_OFFER)

    def draft_sms(self, lead: Lead) -> str:
        """Draft the short text reply.

        Kept under the single-message limit for every project and timeline in
        the sample data, with room for a long first name. A white-label
        company name longer than the demo one can still push it over, which
        is why :attr:`Draft.sms_over_limit` exists rather than being assumed
        false.

        Parameters
        ----------
        lead : Lead
            The lead being replied to.

        Returns
        -------
        str
            A text message, usually inside the single-message limit.
        """
        return (
            f"Hi {lead.first_name}, it's {self._business.owner_name} "
            f'at {self._business.company_name} '
            f'about your {self._label_for(lead)}. '
            f'{self._visit_offer_for(lead)} What days work for you?'
        )

    def draft_subject(self, lead: Lead) -> str:
        """Draft the email subject line.

        Parameters
        ----------
        lead : Lead
            The lead being replied to.

        Leads with "Following up" rather than the project, because that is
        what the homeowner is looking for in a crowded inbox two days after
        they filled in a form. The separator is a middle dot, never an em
        dash: the subject is pasted into mail clients and phones that render
        dashes inconsistently.

        Returns
        -------
        str
            A subject naming the project and the company.
        """
        project = lead.project_type or 'project'
        return f'Following up on your {project.lower()} \u00b7 {self._business.company_name}'

    def draft_email(self, lead: Lead) -> str:
        """Draft the longer email reply.

        Quoting the homeowner's own words back is what separates a reply that
        gets answered from one that reads as a form letter, so the detail line
        is included verbatim whenever they wrote anything.

        Parameters
        ----------
        lead : Lead
            The lead being replied to.

        Returns
        -------
        str
            The email body, ready to paste.
        """
        detail_line = f'You mentioned: "{lead.details}"\n\n' if lead.details else ''
        location_line = f' out in {lead.city}' if lead.city else ''
        return (
            f'Hi {lead.first_name},\n\n'
            f'{self._opener_for(lead)} {self._visit_offer_for(lead)}\n\n'
            f'{detail_line}'
            f'The visit takes about thirty minutes. I measure, ask what you are trying '
            f'to end up with, and flag anything that tends to surprise people on a job '
            f'like this{location_line}. You get a written quote after that, with the '
            f'scope and the number in writing. No charge for any of it.\n\n'
            f'If it is easier to talk it through first, call or text {self._business.phone}.\n\n'
            f'{self._business.owner_name}\n{self._business.company_name}'
        )

    def build_draft(self, lead: Lead) -> Draft:
        """Build the full draft pair for one lead.

        Parameters
        ----------
        lead : Lead
            The lead being replied to.

        Returns
        -------
        Draft
            The text and email drafts.
        """
        return Draft(
            lead=lead,
            sms=self.draft_sms(lead),
            subject=self.draft_subject(lead),
            body=self.draft_email(lead),
        )

    def build_drafts(self, leads: Iterable[Lead]) -> list[Draft]:
        """Build drafts for many leads, urgent ones first.

        Sorting here rather than at the point of display means the CLI and the
        web app agree on ordering, and the contractor sees the reply-today
        leads without scrolling or filtering. The sort is stable, so leads
        with the same urgency keep their file order.

        Parameters
        ----------
        leads : iterable of Lead
            The leads to reply to.

        Returns
        -------
        list of Draft
            Drafts with the urgent ones at the front.
        """
        drafts = [self.build_draft(lead) for lead in leads]
        return sorted(drafts, key=lambda draft: not draft.is_urgent)

    def __str__(self) -> str:
        """Return who this writer writes as."""
        return f'DraftWriter writing as {self._business}'

    def __repr__(self) -> str:
        """Return an unambiguous form for debugging."""
        return f'DraftWriter(business={self._business!r})'


def _iter_report_lines(drafts: Sequence[Draft], source: LeadSource) -> Iterator[str]:
    """Yield the terminal report one line at a time.

    Parameters
    ----------
    drafts : sequence of Draft
        The drafts to print, already ordered.
    source : LeadSource
        Where they came from, named in the header.

    Yields
    ------
    str
        One line of the report.
    """
    urgent_count = sum(1 for draft in drafts if draft.is_urgent)
    yield f'{len(drafts)} lead(s) from {source}'
    yield f'{urgent_count} need a reply today'
    yield ''
    for index, draft in enumerate(drafts, start=1):
        yield f'--- {index} of {len(drafts)} ---'
        yield str(draft)
        yield ''


def _build_parser() -> argparse.ArgumentParser:
    """Define the command line interface.

    Returns
    -------
    argparse.ArgumentParser
        The configured parser.
    """
    parser = argparse.ArgumentParser(
        prog='lead_followup_drafter',
        description=(
            'Draft same-day SMS and email replies for a CSV of leads. '
            'Writes drafts only. It never sends anything and makes no network calls.'
        ),
    )
    parser.add_argument(
        '--csv',
        type=Path,
        default=DEFAULT_CSV_PATH,
        help=f'Lead CSV to read (default: {DEFAULT_CSV_PATH.name} in public/)',
    )
    parser.add_argument(
        '--only-urgent',
        action='store_true',
        help='Print only the leads whose timeline means they need a reply today',
    )
    parser.add_argument(
        '--company',
        default=DEMO_BUSINESS.company_name,
        help=f'Company name to sign as (default: {DEMO_BUSINESS.company_name})',
    )
    parser.add_argument(
        '--owner',
        default=DEMO_BUSINESS.owner_name,
        help=f'Person the messages come from (default: {DEMO_BUSINESS.owner_name})',
    )
    parser.add_argument(
        '--phone',
        default=DEMO_BUSINESS.phone,
        help=f'Callback number printed in the email (default: {DEMO_BUSINESS.phone})',
    )
    parser.add_argument(
        '--json',
        action='store_true',
        help='Print the drafts as JSON instead of text (used by the parity check)',
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command line tool.

    Parameters
    ----------
    argv : sequence of str, optional
        Arguments to parse. Defaults to ``sys.argv[1:]``.

    Returns
    -------
    int
        ``EXIT_OK`` on success, ``EXIT_ERROR`` if the lead file could not be
        used or the business details were rejected.
    """
    args = _build_parser().parse_args(argv)

    try:
        business = Business(
            company_name=args.company,
            owner_name=args.owner,
            phone=args.phone,
        )
        source = CsvLeadSource(args.csv)
        leads = source.read_leads()
    except LeadFollowupError as error:
        print(f'Error: {error}', file=sys.stderr)
        return EXIT_ERROR
    except ValueError as error:
        print(f'Error: {error}', file=sys.stderr)
        return EXIT_ERROR

    drafts = DraftWriter(business).build_drafts(leads)
    if args.only_urgent:
        drafts = [draft for draft in drafts if draft.is_urgent]

    if args.json:
        print(json.dumps([draft.to_dict() for draft in drafts], indent=2))
        return EXIT_OK

    for line in _iter_report_lines(drafts, source):
        print(line)

    if source.skipped_rows:
        print(f'Skipped {source.skipped_rows} row(s) with no name, phone, or email.')
    if source.unmapped_headers:
        print(f'Ignored column(s): {", ".join(source.unmapped_headers)}')
    if source.missing_fields:
        print(f'No column found for: {", ".join(source.missing_fields)}')
    print('These are drafts. Read them, edit anything that is off, then send them yourself.')
    return EXIT_OK


if __name__ == '__main__':
    sys.exit(main())
