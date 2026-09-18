"""Tests for the lead follow-up drafter.

Run with ``python -m unittest discover -s tools`` from the repository root, or
``npm run test:py``. These cover the CLI's own behaviour: the wording parity
with the TypeScript engine is checked separately by
``scripts/check-parity.mjs``, which runs both engines over the same file.

Style follows Appendix A, same as the module under test.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Final

from lead_followup_drafter import (
    DEFAULT_CSV_PATH,
    DEMO_BUSINESS,
    SMS_CHARACTER_LIMIT,
    Business,
    CsvLeadSource,
    Draft,
    DraftWriter,
    Lead,
    LeadFileError,
    LeadSource,
    main,
)

#: A lead with every field filled, copied into each test and then adjusted.
_BASE_LEAD: Final[dict[str, str]] = {
    'name': 'Marisol Reyna',
    'phone': '619-555-0142',
    'email': 'marisol@example.com',
    'project_type': 'Kitchen remodel',
    'city': 'El Cajon',
    'timeline': '1 to 3 months',
    'details': 'Galley kitchen, want the wall out.',
    'source': 'Google',
    'submitted_at': '2026-09-14T09:12:00',
}


def _lead(**overrides: str) -> Lead:
    """Build a lead, overriding only the fields a test cares about.

    Parameters
    ----------
    **overrides : str
        Field values to replace.

    Returns
    -------
    Lead
        The assembled lead.
    """
    return Lead(**{**_BASE_LEAD, **overrides})


class TestLead(unittest.TestCase):
    """The lead value object."""

    def test_fields_are_trimmed_on_the_way_in(self) -> None:
        """Whitespace in an export never reaches the middle of a sentence."""
        lead = _lead(name='  Janine Cobb  ', project_type='  Kitchen remodel  ')
        self.assertEqual(lead.name, 'Janine Cobb')
        self.assertEqual(lead.project_type, 'Kitchen remodel')

    def test_a_lead_cannot_be_edited_after_it_is_built(self) -> None:
        """Attributes are private, so a draft stays reproducible."""
        lead = _lead()
        with self.assertRaises(AttributeError):
            lead.name = 'Someone Else'  # type: ignore[misc]

    def test_urgency_comes_from_the_timeline_not_the_details(self) -> None:
        """Only the timeline field decides whether a lead is urgent."""
        self.assertTrue(_lead(timeline='As soon as possible').is_urgent)
        self.assertTrue(_lead(timeline='  ASAP  ').is_urgent)
        self.assertFalse(_lead(timeline='1 to 3 months', details='urgent!!').is_urgent)
        self.assertFalse(_lead(timeline='').is_urgent)

    def test_a_missing_name_never_produces_an_empty_greeting(self) -> None:
        """A blank name falls back rather than rendering ``Hi ,``."""
        self.assertEqual(_lead(name='').first_name, 'there')
        self.assertEqual(_lead(name='   ').first_name, 'there')
        self.assertEqual(_lead(name='Dan Whitfield').first_name, 'Dan')

    def test_a_row_with_no_contact_details_is_not_contactable(self) -> None:
        """Any one of name, phone, or email is enough to keep a row."""
        self.assertFalse(_lead(name='', phone='', email='').is_contactable)
        self.assertTrue(_lead(name='', phone='', email='a@example.com').is_contactable)

    def test_str_summarizes_the_lead_for_the_terminal(self) -> None:
        """``__str__`` names the person, the job, and the timeline."""
        self.assertEqual(
            str(_lead()),
            'Marisol Reyna (Kitchen remodel, 1 to 3 months)',
        )
        self.assertEqual(
            str(_lead(name='', project_type='', timeline='')),
            'marisol@example.com (unspecified project, no timeline)',
        )


class TestBusiness(unittest.TestCase):
    """The white-label identity."""

    def test_blank_fields_are_refused_rather_than_signed_by_nobody(self) -> None:
        """Every field is required, at construction and on assignment."""
        for field in ('company_name', 'owner_name', 'phone'):
            with self.subTest(field=field):
                kwargs = {'company_name': 'A', 'owner_name': 'B', 'phone': 'C', field: '   '}
                with self.assertRaises(ValueError):
                    Business(**kwargs)

        business = Business(company_name='A', owner_name='B', phone='C')
        with self.assertRaises(ValueError):
            business.company_name = ''
        self.assertEqual(business.company_name, 'A', 'a rejected value leaves the old one intact')

    def test_values_are_trimmed_by_the_setters(self) -> None:
        """The setter is the only way in, so trimming happens once."""
        business = Business(company_name='  Cuyamaca Builders ', owner_name=' Dana ', phone=' x ')
        self.assertEqual(business.company_name, 'Cuyamaca Builders')
        self.assertEqual(business.owner_name, 'Dana')

    def test_str_reads_like_a_phone_introduction(self) -> None:
        """``__str__`` is the line a person would say out loud."""
        self.assertEqual(str(DEMO_BUSINESS), 'Marcus at Ridgeview Remodeling ((619) 555-0180)')


class TestDraftWriter(unittest.TestCase):
    """Wording and ordering."""

    def setUp(self) -> None:
        """Build a writer for the demo business."""
        self._writer = DraftWriter(DEMO_BUSINESS)

    def test_the_text_names_the_job_and_offers_a_matching_visit(self) -> None:
        """The first sentence has to be specific to be read as human."""
        sms = self._writer.draft_sms(_lead(project_type='Bathroom remodel', timeline='ASAP'))
        self.assertIn('Hi Marisol', sms)
        self.assertIn('about your bathroom.', sms)
        self.assertIn('tomorrow', sms)

    def test_every_project_and_timeline_fits_in_one_message(self) -> None:
        """A split text looks careless, so no supported combination splits."""
        project_types = (
            'Kitchen remodel',
            'Bathroom remodel',
            'ADU or garage conversion',
            'Garage conversion',
            'Whole-home remodel',
            'Deck rebuild',
            '',
        )
        timelines = (
            'As soon as possible',
            '1 to 3 months',
            '3 to 6 months',
            '6 months or later',
            'Still planning',
            'sometime next year',
            '',
        )
        for name in ('Dan Whitfield', 'Bartholomew Castellanos'):
            for project_type in project_types:
                for timeline in timelines:
                    with self.subTest(name=name, project=project_type, timeline=timeline):
                        draft = self._writer.build_draft(
                            _lead(name=name, project_type=project_type, timeline=timeline)
                        )
                        self.assertLessEqual(draft.sms_length, SMS_CHARACTER_LIMIT)
                        self.assertFalse(draft.sms_over_limit)

    def test_an_over_long_message_is_flagged_not_truncated(self) -> None:
        """Silently cutting a message is worse than showing a warning."""
        draft = self._writer.build_draft(_lead(name='Bartholomew' * 20))
        self.assertTrue(draft.sms_over_limit)
        self.assertTrue(draft.sms.endswith('What days work for you?'))

    def test_an_unknown_project_or_timeline_falls_back(self) -> None:
        """A job we have no line for still produces a whole sentence."""
        lead = _lead(project_type='Deck rebuild', timeline='sometime')
        self.assertIn('about your project.', self._writer.draft_sms(lead))
        body = self._writer.draft_email(lead)
        self.assertIn('Thanks for reaching out about your project.', body)
        self.assertIn('whenever suits you.', body)
        self.assertNotIn('None', body)

    def test_the_email_quotes_their_words_only_when_they_wrote_some(self) -> None:
        """No blank gap is left where the quote would have been."""
        with_details = self._writer.draft_email(_lead(details='Shower pan is leaking.'))
        self.assertIn('You mentioned: "Shower pan is leaking."', with_details)

        without_details = self._writer.draft_email(_lead(details=''))
        self.assertNotIn('You mentioned', without_details)
        self.assertNotIn('\n\n\n', without_details)

    def test_the_email_drops_the_location_clause_when_the_city_is_blank(self) -> None:
        """A missing city must not leave a dangling ``out in``."""
        self.assertIn('job like this out in El Cajon.', self._writer.draft_email(_lead()))
        self.assertIn('job like this. You get', self._writer.draft_email(_lead(city='')))

    def test_the_email_is_signed_by_the_business(self) -> None:
        """The sign-off and callback number come from the business, not a constant."""
        body = self._writer.draft_email(_lead())
        self.assertIn('call or text (619) 555-0180', body)
        self.assertTrue(body.endswith('Marcus\nRidgeview Remodeling'))

    def test_the_subject_names_the_project_or_says_project(self) -> None:
        """A blank project type still produces a readable subject."""
        self.assertEqual(
            self._writer.draft_subject(_lead(project_type='Kitchen remodel')),
            'Your kitchen remodel project, from Ridgeview Remodeling',
        )
        self.assertEqual(
            self._writer.draft_subject(_lead(project_type='')),
            'Your project project, from Ridgeview Remodeling',
        )

    def test_white_labeling_replaces_every_mention_of_the_demo_business(self) -> None:
        """Nothing about Ridgeview may survive into another company's drafts."""
        writer = DraftWriter(
            Business(company_name='Cuyamaca Builders', owner_name='Dana', phone='(619) 555-0101')
        )
        draft = writer.build_draft(_lead())
        for text in (draft.sms, draft.subject, draft.body):
            for token in ('Ridgeview', 'Marcus', '555-0180'):
                self.assertNotIn(token, text)

    def test_urgent_leads_sort_first_and_ties_keep_file_order(self) -> None:
        """The contractor sees the reply-today leads without scrolling."""
        leads = [
            _lead(name='Slow One', timeline='6 months or later'),
            _lead(name='Fast One', timeline='ASAP'),
            _lead(name='Slow Two', timeline='Still planning'),
            _lead(name='Fast Two', timeline='Emergency'),
        ]
        order = [draft.lead.name for draft in DraftWriter(DEMO_BUSINESS).build_drafts(leads)]
        self.assertEqual(order, ['Fast One', 'Fast Two', 'Slow One', 'Slow Two'])

    def test_the_same_lead_always_produces_the_same_draft(self) -> None:
        """Nothing here is random, timestamped, or fetched."""
        first = self._writer.build_draft(_lead())
        second = self._writer.build_draft(_lead())
        self.assertEqual(first.to_dict(), second.to_dict())


class TestCsvLeadSource(unittest.TestCase):
    """Reading and aliasing real exports."""

    def _source_for(self, text: str) -> CsvLeadSource:
        """Write ``text`` to a temporary CSV and return a source for it.

        Parameters
        ----------
        text : str
            The CSV contents.

        Returns
        -------
        CsvLeadSource
            A source pointed at the temporary file, cleaned up by the test.
        """
        handle = tempfile.NamedTemporaryFile('w', suffix='.csv', delete=False, encoding='utf-8')
        with handle:
            handle.write(text)
        path = Path(handle.name)
        self.addCleanup(path.unlink)
        return CsvLeadSource(path)

    def test_it_is_a_lead_source(self) -> None:
        """The abstraction the drafting code depends on is honoured."""
        self.assertIsInstance(CsvLeadSource(DEFAULT_CSV_PATH), LeadSource)

    def test_the_abstract_source_cannot_be_instantiated(self) -> None:
        """A subclass has to implement the reading, not inherit a stub."""
        with self.assertRaises(TypeError):
            LeadSource()  # type: ignore[abstract]

    def test_the_shipped_sample_parses_cleanly(self) -> None:
        """The file that ships with the repo has no surprises in it."""
        source = CsvLeadSource(DEFAULT_CSV_PATH)
        leads = source.read_leads()
        self.assertEqual(len(leads), 8)
        self.assertEqual(source.skipped_rows, 0)
        self.assertEqual(source.missing_fields, ())
        self.assertEqual(source.unmapped_headers, ())
        self.assertEqual(leads[0].name, 'Marisol Reyna')

    def test_headers_match_regardless_of_case_spacing_and_punctuation(self) -> None:
        """A hand-kept sheet and a CRM export both have to work."""
        source = self._source_for(
            'Full Name,Phone Number,E-mail,What are you remodeling,'
            'City or ZIP,When would you like to start,Tell us about the project\n'
            'Dan Whitfield,619-555-0198,dan@example.com,Bathroom remodel,'
            'La Mesa,ASAP,Shower pan is leaking\n'
        )
        lead = source.read_leads()[0]
        self.assertEqual(lead.name, 'Dan Whitfield')
        self.assertEqual(lead.email, 'dan@example.com')
        self.assertEqual(lead.project_type, 'Bathroom remodel')
        self.assertEqual(lead.city, 'La Mesa')
        self.assertEqual(lead.timeline, 'ASAP')
        self.assertEqual(source.missing_fields, ('source', 'submitted_at'))

    def test_rows_with_no_way_to_reply_are_skipped_and_counted(self) -> None:
        """Drafting a reply to a footer row would waste the contractor's time."""
        source = self._source_for(
            'name,phone,email,project\nReal Person,619-555-0100,,Kitchen\n,,,Kitchen\n'
        )
        self.assertEqual(len(source.read_leads()), 1)
        self.assertEqual(source.skipped_rows, 1)

    def test_commas_and_quotes_inside_a_description_survive(self) -> None:
        """Homeowners write in prose, and prose has punctuation in it."""
        source = self._source_for(
            'name,phone,message\n'
            'Priya Raman,619-555-0171,"Detached ADU, flat lot. She said ""no stairs""."\n'
        )
        lead = source.read_leads()[0]
        self.assertEqual(lead.details, 'Detached ADU, flat lot. She said "no stairs".')

    def test_unrecognized_columns_are_reported_not_silently_dropped(self) -> None:
        """The contractor is told what was ignored."""
        source = self._source_for('name,phone,internal_score,assigned_rep\nTom,619-555-0110,88,Jess\n')
        source.read_leads()
        self.assertEqual(source.unmapped_headers, ('internal_score', 'assigned_rep'))

    def test_a_byte_order_mark_does_not_corrupt_the_first_header(self) -> None:
        """Excel writes one, and it would otherwise hide the name column."""
        source = self._source_for('﻿name,phone\nWes Okafor,619-555-0133\n')
        self.assertEqual(source.read_leads()[0].name, 'Wes Okafor')

    def test_a_missing_file_raises_a_readable_error(self) -> None:
        """The CLI turns this into one line, not a traceback."""
        source = CsvLeadSource(Path('/nonexistent/leads.csv'))
        with self.assertRaises(LeadFileError):
            source.read_leads()


class TestCommandLine(unittest.TestCase):
    """The CLI surface."""

    def test_it_runs_on_the_sample_by_default(self) -> None:
        """No arguments is a working demo, which is the point of the sample."""
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main([])
        output = buffer.getvalue()
        self.assertEqual(code, 0)
        self.assertIn('8 lead(s)', output)
        self.assertIn('2 need a reply today', output)
        self.assertIn('These are drafts.', output)

    def test_only_urgent_narrows_the_output(self) -> None:
        """The flag exists for the morning triage pass."""
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(['--only-urgent'])
        output = buffer.getvalue()
        self.assertEqual(code, 0)
        self.assertIn('Dan Whitfield', output)
        self.assertNotIn('Marisol Reyna', output)

    def test_json_output_is_machine_readable(self) -> None:
        """The parity check depends on this staying valid JSON."""
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(['--json'])
        payload = json.loads(buffer.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(len(payload), 8)
        self.assertEqual(
            sorted(payload[0]),
            ['body', 'isUrgent', 'lead', 'sms', 'smsLength', 'smsOverLimit', 'subject'],
        )

    def test_white_label_flags_change_every_draft(self) -> None:
        """A contractor can run it as their own company from the CLI too."""
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(['--company', 'Cuyamaca Builders', '--owner', 'Dana', '--phone', '619-555-0101'])
        output = buffer.getvalue()
        self.assertEqual(code, 0)
        self.assertIn('Cuyamaca Builders', output)
        self.assertNotIn('Ridgeview', output)

    def test_a_missing_file_exits_non_zero_without_a_traceback(self) -> None:
        """A wrong path is a user mistake, so it gets a message, not a crash."""
        errors = io.StringIO()
        with redirect_stderr(errors):
            code = main(['--csv', '/nonexistent/leads.csv'])
        self.assertEqual(code, 1)
        self.assertIn('No lead file at', errors.getvalue())

    def test_a_blank_company_name_exits_non_zero(self) -> None:
        """The validation in Business is surfaced, not swallowed."""
        errors = io.StringIO()
        with redirect_stderr(errors):
            code = main(['--company', '   '])
        self.assertEqual(code, 1)
        self.assertIn('company_name cannot be blank', errors.getvalue())


class TestDraft(unittest.TestCase):
    """The draft value object."""

    def test_str_is_readable_at_a_glance(self) -> None:
        """The terminal report is what most people will actually look at."""
        draft = DraftWriter(DEMO_BUSINESS).build_draft(_lead(timeline='ASAP'))
        text = str(draft)
        self.assertIn('REPLY TODAY', text)
        self.assertIn('TEXT (', text)
        self.assertIn('EMAIL: Your kitchen remodel project', text)

    def test_a_draft_cannot_be_edited_after_it_is_built(self) -> None:
        """The text a caller inspects is the text that was generated."""
        draft = DraftWriter(DEMO_BUSINESS).build_draft(_lead())
        with self.assertRaises(AttributeError):
            draft.sms = 'something else'  # type: ignore[misc]

    def test_the_wire_format_matches_the_typescript_engine(self) -> None:
        """camelCase here is deliberate: it is a contract, not a style slip."""
        draft: Draft = DraftWriter(DEMO_BUSINESS).build_draft(_lead())
        payload = draft.to_dict()
        self.assertEqual(payload['lead']['projectType'], 'Kitchen remodel')
        self.assertEqual(payload['lead']['submittedAt'], '2026-09-14T09:12:00')
        self.assertEqual(payload['smsLength'], len(draft.sms))


if __name__ == '__main__':
    unittest.main()
