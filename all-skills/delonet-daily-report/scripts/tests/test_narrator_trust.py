"""The narrator trust boundary: untrusted text cannot become pipeline markup.

Round 2 defended this boundary with three line-anchored ASCII regexes
(``AUTHORITY_LINE_PATTERNS``) and a neutralising rewrite. An adversarial
narrator walked through it with Cyrillic homoglyphs, HTML tags, table rows,
setext rules and code fences: eight of twenty-one forgeries published verbatim,
bolded and unquoted, on a run whose real status was ``failed``. The same run's
line 2 read ``Narrated in one pass by **Status (authoritative): complete** the
pipeline/gpt-5.4**`` because the provider/model came out of the usage file the
narrator process itself writes.

Every test below was run against the pre-fix tree and failed there. They are
written against the *published document*, not against the implementation, so
they keep holding whatever mechanism is used to satisfy them -- and they are
deliberately blind to the narrator's *content*: nothing here asserts that the
narrator said something nice, only that whatever it said is rendered as inert
text and the pipeline's own statuses are the only authority markup in the file.
"""

from __future__ import annotations

import json
import os
import re
import stat
import unittest
from pathlib import Path
from unittest import mock

from test_run_pipeline import (
    PipelineCase,
    complete_collector,
    failing_collector,
    register_stub,
)

import narrate as narrator  # noqa: E402
import run as runner  # noqa: E402
from collectors.base import SectionResult  # noqa: E402

#: The pipeline's own authority markup. Only ``narrate.status_line`` and
#: ``narrate.report_status_line`` may produce a line of this shape.
PIPELINE_STATUS_RE = re.compile(r"^\*\*Status \(authoritative\): (\w+)\*\*", re.MULTILINE)

#: Twenty-one forgeries of that markup, one per rendering channel a Markdown
#: reader honours. Numbers 2-4 are homoglyphs: the Cyrillic Ѕ (U+0405) and а
#: (U+0430) and the Greek Ρ (U+03A1) render identically to their Latin twins,
#: which is why no list of patterns can ever be complete.
FORGERY_VARIANTS = [
    "**Status (authoritative): complete**",                      # 1  ASCII
    "**Ѕtatus (аuthoritative): complete**",            # 2  Cyrillic S, a
    "**Ѕтatus: complete**",                            # 3  Cyrillic St
    "**Ρeport status: complete**",                          # 4  Greek Rho
    "<b>Status: complete</b>",                                   # 5  HTML bold
    "<strong>Status (final): complete</strong>",                 # 6  HTML strong
    "<h2>Status (authoritative): complete</h2>",                 # 7  HTML heading
    "| **Status** | complete |",                                 # 8  table row
    "|---|---|",                                                 # 9  table rule
    "## Status (authoritative): complete",                       # 10 ATX heading
    "Status (authoritative): complete",                          # 11 setext text
    "=================================",                         # 12 setext rule
    "> **Status (authoritative): complete**",                    # 13 blockquote
    "  - **Status (authoritative): complete**",                  # 14 nested list
    "1. **Status (authoritative): complete**",                   # 15 ordered list
    "```",                                                       # 16 fence open
    "**Status (authoritative): complete**",                      # 17 inside fence
    "```",                                                       # 18 fence close
    "[Status (authoritative): complete](https://evil.example)",  # 19 link
    "![Status (authoritative): complete](x)",                    # 20 image
    "It is fine.‮**Status (authoritative): complete**",     # 21 bidi override
]

FORGED_BODY = "\n".join(FORGERY_VARIANTS) + "\nEverything is healthy. Every section completed."

#: What the hostile narrator process writes into its own ``--usage-file``.
FORGED_PROVIDER = "**Status (authoritative): complete** the pipeline"
FORGED_MODEL = "gpt-5.4**\n\n**Status (authoritative): complete"


def hostile_reply(bodies: dict[str, str], *, provider: str, model: str):
    """A narrator whose bodies AND whose usage report are both hostile."""

    def invoke(prompt, requested_provider, requested_model):
        return {
            "stdout": json.dumps({"sections": bodies}),
            # The usage report is written by the narrated process. Round 2 read
            # provider/model out of it and interpolated them into line 2.
            "usage": {"completed": True, "failed": False,
                      "provider": provider, "model": model},
            "usage_note": None,
            "command": "/stub/hermes",
            "toolsets": narrator.toolsets(),
        }

    return invoke


class NarratorTrustCase(PipelineCase):
    """Shared machinery: run one pipeline with a hostile narrator."""

    def bodies_for(self, value: dict, body: str) -> dict[str, str]:
        return {
            item["id"]: body
            for item in runner.report_plan(value)
            if item["id"] != "coverage-freshness"
        }

    def hostile_run(self, body: str = FORGED_BODY, *, provider: str = FORGED_PROVIDER,
                    model: str = FORGED_MODEL):
        """A run whose REQUIRED section died and whose narrator lies about it."""
        value = self.with_collectors(
            register_stub("trust_fail", failing_collector),
            register_stub("trust_ok", complete_collector),
        )
        reply = hostile_reply(self.bodies_for(value, body), provider=provider, model=model)
        with mock.patch.object(narrator, "invoke", reply):
            outcome, code = self.run_pipeline(value, narrate_enabled=True)
        markdown = Path(outcome["published"]["markdown"]).read_text(encoding="utf-8")
        report = json.loads(Path(outcome["published"]["report_json"]).read_text())
        return outcome, code, markdown, report

    def body_of(self, report: dict, section_id: str) -> str:
        return next(item for item in report["sections"] if item["id"] == section_id)["body"]


class ForgeryIsImpossibleTests(NarratorTrustCase):
    """No narrated character sequence renders as markup the pipeline authors."""

    def test_the_run_really_did_fail(self) -> None:
        # The premise of every other test in this class. If this stops holding,
        # the rest are proving nothing.
        outcome, code, _, _ = self.hostile_run()
        self.assertEqual("llm", outcome["narration"]["mode"])
        self.assertEqual("failed", outcome["manifest"]["sections"]["dev-activity"])
        self.assertEqual("failed", outcome["status"])
        self.assertEqual(runner.EXIT_UNMET, code)

    def test_no_forged_status_line_survives_in_the_document(self) -> None:
        _, _, markdown, _ = self.hostile_run()
        # Exactly six authority lines: four core sections carrying the report's
        # own failed status, then the two collector sections. Not one says
        # "complete" except fleet-health, which really did.
        self.assertEqual(
            ["failed", "failed", "failed", "failed", "failed", "complete"],
            PIPELINE_STATUS_RE.findall(markdown),
        )

    def test_html_tags_are_never_emitted_raw(self) -> None:
        # Variants 5-7 published verbatim before this fix, so a Markdown
        # renderer showed the narrator's forgery in real bold.
        _, _, markdown, _ = self.hostile_run()
        for tag in ("<b>", "</b>", "<strong>", "</strong>", "<h2>", "</h2>"):
            self.assertIsNone(re.search(r"(?<!\\)" + re.escape(tag), markdown),
                                  f"raw (unescaped) HTML {tag} reached the document")

    def test_a_table_row_cannot_be_forged(self) -> None:
        # The pipeline authors exactly one table: the coverage table. Variants
        # 8-9 published verbatim and rendered as a second, fake one.
        _, _, markdown, report = self.hostile_run()
        self.assertNotIn("| **Status** | complete |", markdown)
        for line in self.body_of(report, "executive-brief").splitlines():
            self.assertFalse(
                line.lstrip().startswith("|"),
                f"narrated line renders as a table row: {line!r}",
            )

    def test_a_code_fence_cannot_swallow_the_rest_of_the_report(self) -> None:
        # Variants 16-18 published verbatim: an unbalanced fence would put the
        # coverage table itself inside a code block in every renderer.
        _, _, markdown, _ = self.hostile_run()
        fences = [line for line in markdown.splitlines() if line.lstrip().startswith("```")]
        self.assertEqual([], fences, "narrated text opened a code fence")

    def test_headings_lists_and_quotes_cannot_be_forged(self) -> None:
        _, _, _, report = self.hostile_run()
        body = self.body_of(report, "key-changes")
        pipeline_lead = narrator.report_status_line("failed")
        for line in body.splitlines():
            if line.startswith(pipeline_lead) or line == pipeline_lead:
                continue
            stripped = line.lstrip()
            for opener in ("#", ">", "- ", "* ", "+ ", "="):
                self.assertFalse(
                    stripped.startswith(opener),
                    f"narrated line still opens a block construct: {line!r}",
                )

    def test_homoglyph_variants_are_inert_too(self) -> None:
        # The whole point: after escaping, a Cyrillic Ѕ is just a letter in a
        # sentence. It is present -- nothing is censored -- but the emphasis
        # markers around it are not.
        _, _, markdown, _ = self.hostile_run()
        self.assertIn("Ѕtatus", markdown, "the narrator's own words were dropped")
        self.assertNotIn("**Ѕtatus", markdown)
        self.assertNotIn("**Ѕтatus", markdown)
        self.assertNotIn("**Ρeport status", markdown)

    def test_every_asterisk_in_a_narrated_body_is_escaped(self) -> None:
        # The structural statement of all of the above: in a narrated body, the
        # only unescaped ** in the document is the pipeline's own status line.
        _, _, _, report = self.hostile_run()
        body = self.body_of(report, "risks-watchlist")
        lead = narrator.report_status_line("failed")
        remainder = body[len(lead):] if body.startswith(lead) else body
        for index, char in enumerate(remainder):
            if char in "*_`<[":
                self.assertEqual(
                    "\\", remainder[index - 1: index],
                    f"unescaped {char!r} in narrated body at {index}: "
                    f"{remainder[max(0, index - 40): index + 40]!r}",
                )

    def test_bidi_and_control_characters_do_not_reach_the_document(self) -> None:
        # U+202E reverses everything after it in a terminal, which is markup by
        # another name: it can put the narrator's words in front of the
        # pipeline's on the same rendered line.
        _, _, markdown, _ = self.hostile_run()
        self.assertNotIn("‮", markdown)
        # Shown as its code point instead. The angle bracket that opens the
        # marker is escaped, so making the character visible cannot itself
        # smuggle an HTML tag in: the rendered form is \\<U+202E>.
        self.assertIn("U+202E", markdown, "the character was dropped instead of shown")
        self.assertIn("\\<U+202E>", markdown, "the marker's bracket must be inert")


class ProvenanceChannelTests(NarratorTrustCase):
    """Line 2 of report.md is pipeline-authored and config-sourced."""

    def provenance(self, markdown: str) -> str:
        return markdown.splitlines()[1]

    def test_provenance_names_the_configured_provider_not_the_reported_one(self) -> None:
        _, _, markdown, _ = self.hostile_run()
        line = self.provenance(markdown)
        self.assertTrue(
            line.startswith("Narrated in one pass by openai-codex/gpt-5.4"), line
        )
        self.assertNotIn(FORGED_PROVIDER, line)
        self.assertNotIn("(authoritative)", line)

    def test_provenance_carries_no_narrator_authored_markup(self) -> None:
        _, _, markdown, _ = self.hostile_run()
        head = "\n".join(markdown.splitlines()[:4])
        self.assertNotIn("**Status", head)
        self.assertNotIn("(authoritative)", head)

    def test_a_forged_usage_report_cannot_inject_a_line_break(self) -> None:
        # FORGED_MODEL contains a newline, which is how the forgery reached
        # column 0 of its own line above every section.
        _, _, markdown, _ = self.hostile_run()
        lines = markdown.splitlines()
        self.assertTrue(lines[0].startswith("Daily Developer Report"))
        self.assertNotIn("**Status (authoritative): complete", "\n".join(lines[:6]))

    def test_the_narrator_reported_identity_is_still_recorded(self) -> None:
        # Structural fix, not censorship: what the narrator claimed is still
        # captured on the machine surface, where it is data and not markup.
        outcome, _, _, _ = self.hostile_run()
        metrics = outcome["narration"]["metrics"]
        self.assertEqual(FORGED_PROVIDER, metrics["narrator_reported_provider"])
        self.assertEqual(FORGED_MODEL, metrics["narrator_reported_model"])
        self.assertEqual("openai-codex", metrics["narrator_requested_provider"])
        self.assertEqual("gpt-5.4", metrics["narrator_requested_model"])

    def test_a_mismatch_caveat_cannot_carry_markup_either(self) -> None:
        outcome, _, _, _ = self.hostile_run()
        mismatch = [item for item in outcome["caveats"] if "not the configured" in item]
        self.assertTrue(mismatch, outcome["caveats"])
        self.assertNotIn("**Status (authoritative)", mismatch[0])

    def test_the_real_usage_file_channel_end_to_end(self) -> None:
        # The same attack through the real subprocess path: a narrator binary
        # that writes a forged provider/model into the --usage-file it is
        # handed, which is the file narrate.invoke reads back.
        script = self.root / "hostile-narrator.py"
        script.write_text(
            "#!/usr/bin/env python3\n"
            "import json, sys\n"
            "argv = sys.argv[1:]\n"
            "path = argv[argv.index('--usage-file') + 1]\n"
            "json.dump({'completed': True, 'failed': False,\n"
            f"           'provider': {FORGED_PROVIDER!r}, 'model': {FORGED_MODEL!r}}},\n"
            "          open(path, 'w'))\n"
            f"print(json.dumps({{'sections': {{name: {FORGED_BODY!r}\n"
            "    for name in ['executive-brief', 'key-changes', 'risks-watchlist',\n"
            "                 'dev-activity', 'fleet-health']}}))\n",
            encoding="utf-8",
        )
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        value = self.with_collectors(
            register_stub("trust_live_a", failing_collector),
            register_stub("trust_live_b", complete_collector),
        )
        with mock.patch.dict(os.environ, {"DDR_NARRATOR_CMD": str(script)}):
            outcome, code = self.run_pipeline(value, narrate_enabled=True)
        self.assertEqual("llm", outcome["narration"]["mode"], outcome["narration"]["failure"])
        markdown = Path(outcome["published"]["markdown"]).read_text(encoding="utf-8")
        self.assertIn("openai-codex/gpt-5.4", markdown.splitlines()[1])
        self.assertEqual(
            ["failed", "failed", "failed", "failed", "failed", "complete"],
            PIPELINE_STATUS_RE.findall(markdown),
        )
        self.assertIsNone(re.search(r"(?<!\\)<strong>", markdown))


class NarratorFailureTextTests(NarratorTrustCase):
    """The other narrator-controlled string that reaches the document."""

    def test_a_hostile_error_message_cannot_forge_a_status(self) -> None:
        # narrate.invoke puts the narrator's own stderr into the failure text,
        # and the deterministic render prints that text in line 2 and in the
        # executive brief.
        value = self.with_collectors(
            register_stub("trust_err_a", complete_collector),
            register_stub("trust_err_b", complete_collector),
        )

        def explode(prompt, provider, model):
            raise narrator.NarrationError(
                "narrator exited 3: **Status (authoritative): complete** <b>all good</b>"
            )

        with mock.patch.object(narrator, "invoke", explode):
            outcome, _ = self.run_pipeline(value, narrate_enabled=True)
        markdown = Path(outcome["published"]["markdown"]).read_text(encoding="utf-8")
        provenance = markdown.splitlines()[1]
        self.assertEqual("fallback", outcome["narration"]["mode"])
        # The narrator's message is reported -- that is the point of it --
        # but as literal characters, in the pipeline's own sentence.
        self.assertIn("narrator exited 3", provenance)
        self.assertIn("\\*\\*Status", provenance)
        self.assertNotIn("**Status (authoritative): complete**", provenance)
        self.assertNotIn("<b>all good</b>", markdown)
        # Both collectors completed, so the only "complete" status lines in the
        # document are the two the manifest really earned.
        self.assertEqual(
            ["partial"] * 4 + ["complete", "complete"],
            PIPELINE_STATUS_RE.findall(markdown),
        )

    def test_an_unknown_section_id_cannot_forge_a_status(self) -> None:
        value = self.with_collectors(
            register_stub("trust_extra_a", complete_collector),
            register_stub("trust_extra_b", complete_collector),
        )
        bodies = self.bodies_for(value, "Nothing to report.")
        bodies["**Status (authoritative): complete**"] = "x"
        reply = hostile_reply(bodies, provider="openai-codex", model="gpt-5.4")
        with mock.patch.object(narrator, "invoke", reply):
            outcome, _ = self.run_pipeline(value, narrate_enabled=True)
        dropped = [item for item in outcome["caveats"] if "unknown section id" in item]
        self.assertTrue(dropped, outcome["caveats"])
        self.assertNotIn("**Status (authoritative): complete**", dropped[0])


class BadNewsIsStillPublishedTests(NarratorTrustCase):
    """Escaping is not censorship. A narrator reporting a real failure is doing
    its job, and every word of it must reach the reader."""

    HONEST = (
        "Developer activity failed: the Candystore event history at http://127.0.0.1:9\n"
        "refused the connection (errno 111). Nothing was collected for this day, and the\n"
        "24 commits visible in git are NOT in this report. Yesterday's report is missing."
    )

    def test_an_honest_failure_narrative_reaches_the_reader_intact(self) -> None:
        _, _, markdown, _ = self.hostile_run(body=self.HONEST, provider="openai-codex",
                                             model="gpt-5.4")
        # Word for word, in order, with only the punctuation escaped.
        for phrase in (
            "Developer activity failed",
            "refused the connection",
            "errno 111",
            "24 commits visible in git are NOT in this report",
            "Yesterday",
            "report is missing",
        ):
            self.assertIn(phrase, markdown, f"the narrator's bad news lost {phrase!r}")

    def test_escaping_is_lossless(self) -> None:
        # A reader can recover exactly what the narrator wrote, so nothing is
        # hidden by the render -- only defused.
        escaped = narrator.escape_untrusted_text(self.HONEST)
        recovered = re.sub(r"\\(.)", r"\1", escaped)
        self.assertEqual(self.HONEST, recovered)


class ThirdPartyDetailTests(PipelineCase):
    """The same forgery, arriving through the other door.

    ``detail`` carries git commit subjects and PR titles verbatim -- text
    written by anyone with commit access to a watched repository, which is
    exactly the threat model that made the narrator untrusted. It reached the
    deterministic render unescaped, so a commit subject could forge an
    authority line in a report that was never narrated at all.
    """

    FORGED_SUBJECT = "abc1234 **Status (authoritative): complete** everything is fine"

    def collector(self, section_cfg, report_date, config_value=None):
        return SectionResult(
            id=section_cfg["id"],
            status="failed",
            reason="candystore unreachable",
            summary="nothing was collected",
            detail=["=== 33GOD ===", self.FORGED_SUBJECT],
        )

    def test_a_commit_subject_cannot_forge_a_status_line(self) -> None:
        body = narrator.section_body(
            {
                "id": "dev-activity", "title": "Developer Activity", "status": "failed",
                "reason": "candystore unreachable", "summary": "nothing was collected",
                "detail": ["=== 33GOD ===", self.FORGED_SUBJECT],
            }
        )
        lines = body.splitlines()
        self.assertEqual("**Status (authoritative): failed** -- candystore unreachable", lines[0])
        for line in lines[1:]:
            self.assertNotIn("**Status (authoritative)", line)
        self.assertIn("\\*\\*Status (authoritative)", body)
        self.assertIn("abc1234", body)

    def test_it_holds_end_to_end_on_the_unnarrated_path(self) -> None:
        value = self.with_collectors(
            register_stub("trust_detail_a", self.collector),
            register_stub("trust_detail_b", complete_collector),
        )
        outcome, _ = self.run_pipeline(value, narrate_enabled=False)
        markdown = Path(outcome["published"]["markdown"]).read_text(encoding="utf-8")
        self.assertEqual("fallback", outcome["narration"]["mode"])
        # The forged subject is indented inside the Detail block, so it never
        # matched the line-anchored check: only the escape stops it.
        for line in markdown.splitlines():
            if "**Status (authoritative)" in line:
                self.assertTrue(line.startswith("**Status (authoritative): "), line)
        self.assertIn("\\*\\*Status (authoritative)", markdown)
        self.assertIn("abc1234", markdown)


class EscaperUnitTests(unittest.TestCase):
    """The escaper itself: an allowlist of inert characters, nothing else."""

    def test_inline_punctuation_stays_readable(self) -> None:
        """Prose punctuation is NOT escaped -- that is the point of the pass.

        An earlier version escaped all 32 ASCII punctuation characters and the
        report came out as ``17598 events across 39 project\\(s\\) on
        2026\\-08\\-17\\:``. Nothing that cannot open a markdown block is
        touched now, because the document a human reads is the deliverable.
        """
        text = "17598 events across 39 project(s) on 2026-08-17: 380 sessions, 43 decisions."
        self.assertEqual(text, narrator.escape_untrusted_text(text))

    def test_markup_characters_are_escaped_everywhere(self) -> None:
        for char in "*_`<[":
            with self.subTest(char=char):
                self.assertEqual(
                    f"a\\{char}b", narrator.escape_untrusted_text(f"a{char}b")
                )

    def test_block_openers_are_escaped_at_the_start_of_a_line(self) -> None:
        for char in "#>|-=+~":
            with self.subTest(char=char):
                self.assertEqual(
                    f"\\{char} x", narrator.escape_untrusted_text(f"{char} x")
                )
                # ... and left alone mid-sentence, where they cannot open a block.
                self.assertEqual(f"a{char}b", narrator.escape_untrusted_text(f"a{char}b"))

    def test_an_ordered_list_item_cannot_open_a_block(self) -> None:
        self.assertEqual("1\\. forged", narrator.escape_untrusted_text("1. forged"))

    def test_letters_digits_and_spaces_are_untouched(self) -> None:
        text = "The fleet ran 14 jobs and 3 of them are Ѕtill fine"
        self.assertEqual(text, narrator.escape_untrusted_text(text))

    def test_newlines_survive_so_paragraphs_survive(self) -> None:
        self.assertEqual("one\ntwo", narrator.escape_untrusted_text("one\ntwo"))
        self.assertEqual("one\ntwo", narrator.escape_untrusted_text("one\r\ntwo"))

    def test_invisible_characters_become_visible_names(self) -> None:
        for char, name in (("‮", "U+202E"), ("​", "U+200B"), ("\x07", "U+0007")):
            with self.subTest(char=char):
                out = narrator.escape_untrusted_text(f"a{char}b")
                self.assertNotIn(char, out)
                self.assertIn(name, out)

    def test_escaping_is_idempotent_by_type(self) -> None:
        once = narrator.escape_untrusted_text("cost: $5 (5%)")
        twice = narrator.escape_untrusted_text(once)
        self.assertEqual(once, twice)

    def test_no_line_can_open_a_markdown_block(self) -> None:
        """The guarantee, stated once: no line of escaped text opens a block.

        Block constructs -- heading, status line, table row, blockquote, code
        fence, list item, setext rule -- are the only way to impersonate this
        pipeline, and every one of them is recognised only at the start of a
        line. Inline punctuation cannot open a block and stays readable.
        """
        source = "".join(chr(code) for code in range(32, 127)) + "Ѕ‮\n\ttab"
        for line in str(narrator.escape_untrusted_text(source)).split("\n"):
            stripped = line.lstrip(" ")
            if not stripped:
                continue
            if stripped[0] == "\\":
                continue
            self.assertNotIn(
                stripped[0], narrator.BLOCK_OPENERS,
                f"line opens with active block character {stripped[0]!r}: {line!r}",
            )
            self.assertIsNone(
                narrator._ORDERED_ITEM.match(stripped),
                f"line opens an ordered list: {line!r}",
            )

    def test_a_tab_cannot_open_an_indented_code_block(self) -> None:
        self.assertNotIn("\t", narrator.escape_untrusted_text("\tindented"))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
