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
 * STEP        { name, label, prompt, parse, field | apply, optional, confirmEach }
 *   parse     name | email | phone | sentence | list | plate | yesNo | vehicle
 *             | money:rate | money:amount
 *   field     form input to write the answer into
 *   apply     named writer for answers spanning several fields (see app.js)
 *   optional  "skip" is accepted and leaves it blank
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

  /**
   * Seeds vendor recognition so "autozone spark plugs" splits into a shop and
   * a part. Spellings already used on the job are added automatically, so this
   * only needs the regulars.
   */
  vendors: ["AutoZone", "O'Reilly", "NAPA"],

  newJob: {
    intro: "Let's open a new job. I'll ask, you talk, and I'll read it back after each part.",

    sections: [
      {
        summary: [
          "I have the customer as ", { field: "customerName" },
          { field: "customerPhone", prefix: ", phone ", fallback: ", no phone" },
          { field: "customerEmail", prefix: ", email ", fallback: ", no email" },
          "."
        ],
        steps: [
          {
            name: "customerName",
            label: "the customer name",
            prompt: "Whose car are we working on?",
            parse: "name",
            field: "customerName",
            // Spelled out as well as spoken: this is the one field the customer
            // portal signs in on, and a silently "corrected" name locks them out.
            confirmEach: "Is {value}, spelled {spelled}, correct?",
            retryAfterNo: "No problem — say the name again."
          },
          {
            name: "customerPhone",
            label: "the phone number",
            optional: true,
            prompt: "What's {customerName}'s phone number? Say skip if you don't have it.",
            parse: "phone",
            field: "customerPhone",
            confirmEach: "Is {value} correct?",
            retryAfterNo: "Let's get that number again."
          },
          {
            name: "customerEmail",
            label: "the email",
            optional: true,
            prompt: "What's {customerName}'s email? Say skip if you don't have it.",
            parse: "email",
            field: "customerEmail"
          }
        ]
      },

      {
        summary: [
          "That's a ",
          { fields: ["vehicleYear", "vehicleMake", "vehicleModel"], join: " " },
          { field: "vehiclePlate", format: "spell", prefix: ", plate ", fallback: ", no plate" },
          "."
        ],
        steps: [
          {
            name: "vehicle",
            label: "the vehicle",
            prompt: "What's the year, make, and model for {customerName}'s car?",
            parse: "vehicle",
            apply: "vehicle"
          },
          {
            name: "vehiclePlate",
            label: "the plate",
            optional: true,
            prompt: "What's the plate on {customerName}'s car? Say skip if you don't have it.",
            parse: "plate",
            field: "vehiclePlate"
          }
        ]
      },

      {
        summary: [
          "The work is: ", { field: "agreedWork" },
          ". Labor is ", { field: "laborRateCents", format: "money" }, " an hour."
        ],
        steps: [
          {
            name: "agreedWork",
            label: "the work",
            prompt: "What things are we going to get done on {customerName}'s car?",
            parse: "sentence",
            field: "agreedWork"
          },
          {
            name: "laborRateCents",
            label: "the labor rate",
            prompt: "What's the rate that we're charging?",
            parse: "money:rate",
            apply: "laborRate"
          }
        ]
      },

      {
        summary: [
          {
            field: "materials",
            format: "list",
            prefix: "Approved parts: ",
            suffix: ".",
            fallback: "No approved parts yet."
          }
        ],
        steps: [
          {
            name: "materials",
            label: "the parts",
            optional: true,
            prompt: "Do we need any materials?",
            parse: "list",
            apply: "materials"
          }
        ]
      }
    ],

    creating: "Creating the job now.",
    clockIn: {
      prompt: "Job created. Ready to clock in?",
      label: "the clock-in answer",
      yes: "Clocked in. The billable clock is running.",
      no: "Leaving the clock stopped. Tap clock in when you start."
    },
    stopped: "Voice stopped — the form is filled in as far as we got."
  },

  /** Runtime tokens available below: {vendor} {parts} {amount} {count} {s} */
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
