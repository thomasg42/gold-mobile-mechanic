/**
 * EXAMPLE — a second trade, for reference only.
 *
 * This file is not loaded by the app. It exists to show what changes when the
 * same voice engine is pointed at a different business: only this file.
 *
 * A house-cleaning service has no vehicles, no plates and no parts counter,
 * yet it needs no new engine code and no new parsers — every step below uses
 * a generic parser (name, email, sentence, list, money) writing into a single
 * form input. Trades only need code when they need a custom parser, the way
 * automotive needs `vehicle` to split "a 2018 Ford F-150" into three fields.
 *
 * To stand up a new trade:
 *   1. Copy this file to voice-config.js.
 *   2. Make each `field` match an input name in that business's own form.
 *   3. Reword the prompts and read-backs in the owner's own voice.
 * Nothing in voice.js or the runner in app.js is edited.
 */
window.VoiceConfig = {
  business: "Example Cleaning Co.",

  vendors: ["Costco", "Walmart", "Home Depot", "Dollar General"],

  newJob: {
    intro: "Let's open a new clean. I'll ask, you talk, and I'll read it back after each part.",

    sections: [
      {
        summary: [
          "I have the customer as ", { field: "customerName" },
          { field: "customerEmail", prefix: ", email ", fallback: ", no email" },
          "."
        ],
        steps: [
          {
            name: "customerName",
            label: "the customer name",
            prompt: "Who are we cleaning for today?",
            parse: "name",
            field: "customerName"
          },
          {
            name: "customerEmail",
            label: "the email",
            optional: true,
            prompt: "What's their email? Say skip if you don't have it.",
            parse: "email",
            field: "customerEmail"
          }
        ]
      },

      {
        summary: [
          "That's ", { field: "propertyAddress" },
          { field: "propertySize", prefix: ", ", fallback: ", size not given" },
          "."
        ],
        steps: [
          {
            name: "propertyAddress",
            label: "the address",
            prompt: "What's the address?",
            parse: "sentence",
            field: "propertyAddress"
          },
          {
            name: "propertySize",
            label: "the size",
            optional: true,
            prompt: "How many bedrooms and bathrooms? Say skip if you're not sure.",
            parse: "sentence",
            field: "propertySize"
          }
        ]
      },

      {
        summary: [
          "The work is: ", { field: "agreedWork" },
          ". Rate is ", { field: "laborRateCents", format: "money" }, " an hour."
        ],
        steps: [
          {
            name: "agreedWork",
            label: "the work",
            prompt: "What are we doing on this clean?",
            parse: "sentence",
            field: "agreedWork"
          },
          {
            name: "laborRateCents",
            label: "the rate",
            prompt: "What's the rate per hour?",
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
            prefix: "Supplies: ",
            suffix: ".",
            fallback: "No extra supplies."
          }
        ],
        steps: [
          {
            name: "materials",
            label: "the supplies",
            optional: true,
            prompt: "Any supplies to bill for? Say skip if there aren't any.",
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

  receipts: {
    ask: "Do we have any receipts?",
    none: "No receipts then.",
    add: "Go ahead and add the receipt in.",
    photoButton: "Take receipt photo",
    what: "What is this receipt for?",
    whatRetry: "Where was that from, and what did you get?",
    parts: "What did you get from {vendor}?",
    amount: "Okay — {vendor}, {parts}. How much did that cost?",
    confirm: "{vendor}, {parts}, {amount}.",
    redo: "Let's redo that receipt.",
    more: "Got it. Any more receipts?",
    filing: "Filing {count} receipt{s}."
  },

  closeout: {
    recommendations: "Anything to flag for the customer? Say skip if there isn't.",
    invoice: "Here's the invoice for {subject}. Labor {labor}, supplies {parts}, total {total}.",
    declined: "Leaving the job open so you can fix it.",
    filed: "Invoice filed."
  }
};
