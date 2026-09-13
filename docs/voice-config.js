/**
 * What the voice assistant asks on a Gold Mobile Mechanic job.
 *
 * This file is data, not logic: the questions, their order, which form field
 * each answer lands in, and the exact read-back wording. Rewording what Ken
 * asks is an edit here, never a change to voice.js or the runner in app.js.
 *
 * The wording below is Thomas's own, dictated 2026-08-09. Keep it his.
 *
 * It ships as a script rather than JSON so it caches with the offline app shell
 * and needs no fetch on a driveway with one bar of signal.
 *
 * ---------------------------------------------------------------------------
 * STEP        { name, label, prompt, parse, field | apply, optional, confirmEach,
 *               patience, aliases }
 *   parse     name | email | phone | sentence | list | plate | yesNo | vehicle
 *             | money:rate | money:amount
 *   field     form input to write the answer into
 *   apply     named writer for answers spanning several fields (see app.js)
 *   optional  "skip" is accepted and leaves it blank
 *   patience  "normal" (default) cuts about two seconds after you stop; "long"
 *             waits roughly seven seconds of real silence and lets the answer
 *             run for minutes. Use it on anything open-ended — a mechanic
 *             listing work pauses to think, and a short cut-off reads as the
 *             app hanging up mid-sentence.
 *   aliases   extra words that point a "fix the ___" repair at this step
 *   prompt    may use {token} for anything already captured in this interview,
 *             so a follow-up names the customer instead of re-asking blind
 *   confirmEach  read this answer back on its own, right after it lands, and
 *             re-ask on a no. Tokens: {value} and {spelled}. Use it wherever
 *             the exact characters matter — a name is never auto-corrected, so
 *             the confirmation is what catches a misheard spelling.
 *
 * SUMMARY     array of parts, spoken back before asking "Is that correct?"
 *   "literal text"
 *   { field, prefix, suffix, fallback, format }   format: money | spell | list
 *   { fields: [...], join }
 * ---------------------------------------------------------------------------
 */
window.VoiceConfig = {
  business: "Gold Mobile Mechanic",

  // Opening a job is no longer scripted — the shop agent asks its own
  // questions (see assistant.js). What is left here is the receipt and
  // closeout wording, where the fixed order IS the audit trail.

  /**
   * Seeds vendor recognition so "autozone spark plugs" splits into a shop and
   * a part. Spellings already used on the job are added automatically, so this
   * only needs the regulars.
   */
  vendors: ["AutoZone", "O'Reilly", "NAPA"],

  receipts: {
    ask: "Do we have any receipts?",
    none: "No receipts then.",
    add: "Go ahead and add the receipt in.",
    photoButton: "Take receipt photo",
    what: "What is this receipt for?",
    whatRetry: "Who was that from, and what did you get?",
    parts: "What did you get from {vendor}?",
    amount: "Okay — {vendor}, {parts}. How much did that cost?",
    confirm: "{vendor}, {parts}, {amount}.",
    redo: "Let's redo that receipt.",
    more: "Got it. Any more receipts?",
    filing: "Filing {count} receipt{s}."
  },

  /** Runtime tokens: {subject} {labor} {parts} {total} */
  closeout: {
    recommendations: "Any recommendations for the customer? Say skip if there aren't any.",
    invoice: "Here's the invoice for {subject}. Labor {labor}, parts {parts}, total {total}.",
    declined: "Leaving the job open so you can fix it.",
    filed: "Invoice filed."
  }
};
