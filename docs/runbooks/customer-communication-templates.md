# Runbook: customer communication templates for action impact

**AC4:** "customer communication templates exist for an action that caused impact."

For when a response action — approved by the tenant's own owner, executed correctly, but
WRONG (a false positive: the account disabled, the mailbox rule deleted, the password
reset, was not actually part of an attack) — caused real disruption to a real person's
work. Voice follows `docs/design/ui-ux-spec.md` §9: plain, direct, no jargon, no
manufactured urgency, no corporate hedging. These are starting points for the person
sending them to edit, not a script to paste verbatim.

## 1. Immediate notice — impact discovered or suspected

Send as soon as the mistake is known, before full root cause is understood. Speed matters
more than completeness here.

> Subject: We need to tell you about something we got wrong
>
> Hi {{owner_name}},
>
> On {{date}} at {{time}}, Sentinel {{action_plain_description}} for {{affected_person}}'s
> account, after you approved it. We now believe this was a mistake — the activity that
> triggered it does not look like an actual attack.
>
> {{affected_person}} may currently be locked out / unable to access their mailbox rules /
> need to set a new password [choose the one that applies]. We are fixing this now and will
> follow up within {{commitment_time}} with what happened and what we've done about it.
>
> If {{affected_person}} needs access restored immediately, here's what to do right now:
> {{immediate_workaround_if_any}}
>
> — The Sentinel team

## 2. Follow-up — resolved or reversed

> Subject: What happened on {{date}}, and what we've fixed
>
> Hi {{owner_name}},
>
> Here's what happened: {{plain_english_root_cause}}.
>
> What we did:
> - {{reversal_action_taken}} (see docs/runbooks/playbook-reversal-procedures.md for what
>   was and wasn't automatically reversible)
> - {{what_changed_to_prevent_recurrence}}
>
> {{affected_person}}'s access is back to normal. If anything still looks wrong on their
> end, reply to this email and we'll look right away.
>
> We're sorry for the disruption this caused.
>
> — The Sentinel team

## 3. When full reversal was not possible

Use this specifically for `delete_inbox_rule` (Graph does not restore a deleted rule) or
any action where the honest answer is "we can't fully undo this."

> Subject: {{affected_person}}'s mailbox rule — what we can and can't restore
>
> Hi {{owner_name}},
>
> The mailbox rule we removed from {{affected_person}}'s account on {{date}} can't be
> automatically restored — Microsoft's own system doesn't keep a copy once a rule is
> deleted. Here's what we captured about it before removing it, so it can be recreated by
> hand if it was legitimate:
>
> - Rule name: {{rule_display_name}}
> - Approximate conditions/actions (from the original alert, not guaranteed complete):
>   {{best_effort_rule_description}}
>
> If you'd like it recreated, let us know and we'll walk through it together, or your IT
> admin can add it back directly in Outlook.
>
> — The Sentinel team

## 4. Internal escalation note (not customer-facing)

Pair every external send above with an internal audit trail entry and, for a genuinely
material impact (not a single edge case caught same-day), the SAME product-incident
process `docs/runbooks/reduction-ratio-degraded.md` already establishes — what regressed
in the detection/scoring that led to the false positive, which tenants were affected, and
the fix, linked from here once filed.
