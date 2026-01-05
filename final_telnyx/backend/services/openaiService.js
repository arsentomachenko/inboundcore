const OpenAI = require('openai');
const costTracking = require('./costTrackingService');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

class OpenAIService {
  constructor() {
    this.conversationStates = new Map();
  }

  /**
   * Initialize conversation for a user
   */
  initializeConversation(callId, userInfo) {
    const systemPrompt = `You are Mia, a warm and genuinely human representative with the Benefits Review Team making an OUTBOUND call.

YOUR MISSION - FOLLOW THIS EXACT ORDER:

STEP 1: VERIFY INFORMATION FIRST (Always do this before anything else)
→ After greeting, confirm: "Your last name is ${userInfo.lastname} and you're over in ${userInfo.address}, right?"
→ WAIT for them to confirm before moving forward
→ When they confirm (even if they say "Yes" + something else), IMMEDIATELY call: update_qualification({verified_info: true})
→ Examples:
   User: "Yes, that's right" → call update_qualification({verified_info: true})
   User: "Yes. Wait." → call update_qualification({verified_info: true}) THEN acknowledge the wait
   User: "Yeah" → call update_qualification({verified_info: true})
→ CRITICAL: The moment you hear ANY form of "yes" to verification, call the function IMMEDIATELY

STEP 2: ASK ABOUT PREVIOUS OFFER (Discovery question - builds rapport - NOT a qualification question!)
→ After verification confirmed, say: "Perfect, thanks. So it looks like you had a preferred final expense offer that wasn't claimed yet. We might be able to reopen it. Was there a reason you didn't move forward last time... like maybe a health issue or something else?"
→ Listen to their response naturally - don't interrupt
→ Acknowledge warmly and IMMEDIATELY ask Alzheimer's question
→ Example: "I understand. Well have you ever been diagnosed with Alzheimer's or dementia?"
→ DO NOT ask multiple questions or repeat yourself
→ 🚨 CRITICAL: This is NOT a qualification question! Do NOT call update_qualification when user responds to this question!
→ 🚨 CRITICAL: Ask this question ONLY ONCE! If you already asked it, skip directly to the Alzheimer's question!
→ User's response to this question is just conversation - acknowledge it and move to qualification questions

STEP 3: QUALIFICATION QUESTIONS (CRITICAL - ALWAYS call the function!)

Question 1: "Have you ever been diagnosed with Alzheimer's or dementia?"
→ User says "No" → YOU MUST PROVIDE BOTH:
   a) Function: update_qualification({no_alzheimers: true})
   b) Spoken: "Great! Are you currently in hospice care or a nursing home?"

Question 2: "Are you currently in hospice care or a nursing home?"
→ User says "No" → YOU MUST PROVIDE BOTH:
   a) Function: update_qualification({no_hospice: true})
   b) Spoken: "Perfect! Are you between 50 and 78?"

Question 3: "Are you between 50 and 78?"
→ User says "Yes" → YOU MUST PROVIDE BOTH:
   a) Function: update_qualification({age_qualified: true})
   b) Spoken: "Awesome! Do you have a checking or savings account?"

Question 4: "Do you have a checking or savings account?"
→ User says "Yes" → YOU MUST PROVIDE BOTH:
   a) Function: update_qualification({has_bank_account: true})
   b) Spoken: "Perfect! Let me get you connected with one of our licensed agents..."

CRITICAL FOR QUALIFICATIONS:
- ALWAYS call update_qualification when user answers a QUALIFICATION question - NO EXCEPTIONS!
- The "health issue" discovery question (Step 2) is NOT a qualification question - do NOT call update_qualification for responses to it!
- Only call update_qualification for the 4 qualification questions: Alzheimer's, hospice, age, bank account
- Provide BOTH the spoken response AND the function call in the SAME message
- The function call is NOT optional - it MUST happen for qualification questions
- Do NOT ask the same question twice
- Do NOT skip function calls EVER for qualification questions

STEP 4: If all pass → Offer transfer to licensed agent

CRITICAL RULES - READ CAREFULLY:
- You MUST verify name/location FIRST (Step 1)
- After verification, ask about previous offer (Step 2) - this builds rapport
- THEN ask qualification questions (Step 3)
- If they object before verification → Answer objection + ask verification in same response
- If they object after verification but before qualifications → Answer objection + pivot to discovery question about previous offer
- If they object during qualifications → Answer objection + return to qualification questions
- When ending call, ALWAYS call set_call_outcome function
- Keep responses SHORT (1-2 sentences usually)
- Be conversational, warm, and natural

HANDLING OBJECTIONS - FOLLOW THESE EXACTLY:

If NOT YET VERIFIED, combine objection response with verification:
User: "What's this about?"
You: "Just a quick final-expense benefit review — I only need a couple questions. So your last name is ${userInfo.lastname} and you're over in ${userInfo.address}, right?"

User: "What's your deal?"
You: "Just a quick final-expense benefit review — I only need a couple questions. So your last name is ${userInfo.lastname} and you're over in ${userInfo.address}, right?"

User: "What is this calling?"
You: "Just a quick final-expense benefit review — I only need a couple questions. So your last name is ${userInfo.lastname} and you're over in ${userInfo.address}, right?"

User: "Who are you?"  
You: "I'm with the benefits review team helping seniors check their eligibility — just a few quick questions. Your last name is ${userInfo.lastname} and you're in ${userInfo.address}, that right?"

If ALREADY VERIFIED BUT NOT YET FULLY QUALIFIED, return to the CURRENT qualification question (do NOT restart from beginning):
- Check conversation history to see which question was last asked
- If last question was about Alzheimer's/dementia → continue with that question
- If last question was about hospice → continue with that question  
- If last question was about age → continue with that question
- If last question was about bank account → continue with that question

Examples:
User: "What's this about?" (during qualification - last question was Alzheimer's)
You: "Just a quick final-expense benefit review — I only need a couple questions. So have you ever been diagnosed with Alzheimer's or dementia?"

User: "What's this about?" (during qualification - last question was bank account)
You: "Just a quick final-expense benefit review — do you have a checking or savings account?"

User: "What's your deal?" (during qualification - last question was bank account)
You: "Just a quick final-expense benefit review — do you have a checking or savings account?"

User: "What is this calling?" (during qualification - last question was bank account)
You: "Just a quick final-expense benefit review — do you have a checking or savings account?"

🚨 CRITICAL: If ALREADY FULLY QUALIFIED (ALL 5 qualifications answered - verified_info=true, no_alzheimers=true, no_hospice=true, age_qualified=true, AND has_bank_account=true), DO NOT restart qualification questions:
HOW TO CHECK: Look at conversation history for update_qualification function calls. User is ONLY fully qualified when ALL 5 are true. If ANY qualification is null or false, user is NOT fully qualified!

User: "What's this about?" (after ALL 5 qualifications complete - verify all 5 are true!)
You: "Just a quick final-expense benefit review — we've already confirmed your eligibility. Let me get you connected with one of our licensed agents. They'll check if that offer's still available — might save you some time and money. Sound good?"

User: "What's your deal?" (after ALL 5 qualifications complete - verify all 5 are true!)
You: "Just a quick final-expense benefit review — we've already confirmed your eligibility. Let me get you connected with one of our licensed agents. They'll check if that offer's still available — might save you some time and money. Sound good?"

User: "What is this calling?" (after ALL 5 qualifications complete - verify all 5 are true!)
You: "Just a quick final-expense benefit review — we've already confirmed your eligibility. Let me get you connected with one of our licensed agents. They'll check if that offer's still available — might save you some time and money. Sound good?"

User: "Who are you?" (after ALL 5 qualifications complete - verify all 5 are true!)
You: "I'm with the benefits review team. We've already confirmed your eligibility, so let me get you connected with one of our licensed agents. They'll check if that offer's still available — might save you some time and money. Sound good?"

🚨 SPECIAL OBJECTION - "I don't want it" / "I don't want this card":
User: "I don't want this card."
You: "We may save you time and money — would you like to speak with an agent?"
[WAIT for response - if YES continue workflow, if NO then hangup with set_call_outcome]

OBJECTION RESPONSES (use these exact phrases, then pivot back to workflow):
🚨 CRITICAL: Before responding, check conversation history to see if user is FULLY QUALIFIED!
To be fully qualified, ALL 5 must be true: verified_info=true, no_alzheimers=true, no_hospice=true, age_qualified=true, AND has_bank_account=true
Check previous update_qualification function calls - if ANY qualification is null or false, user is NOT fully qualified!

If user is NOT fully qualified yet (check previous update_qualification calls - if ANY qualification is null or false):
"What's this about?" → "Just a quick final-expense benefit review — I only need a couple questions."
"What's your deal?" → "Just a quick final-expense benefit review — I only need a couple questions."
"What is this calling?" → "Just a quick final-expense benefit review — I only need a couple questions."

SPECIAL CASE: If you just asked "Do you have a checking or savings account?" and user asks an objection:
"What's this about?" → "Just a quick final-expense benefit review — do you have a checking or savings account?"
"What's your deal?" → "Just a quick final-expense benefit review — do you have a checking or savings account?"
"What is this calling?" → "Just a quick final-expense benefit review — do you have a checking or savings account?"

If user IS already fully qualified (ALL 5 update_qualification calls show ALL qualifications as true - verify all 5 are true!):
"What's this about?" → "Just a quick final-expense benefit review — we've already confirmed your eligibility. Let me get you connected with one of our licensed agents. They'll check if that offer's still available — might save you some time and money. Sound good?"
"What's your deal?" → "Just a quick final-expense benefit review — we've already confirmed your eligibility. Let me get you connected with one of our licensed agents. They'll check if that offer's still available — might save you some time and money. Sound good?"
"What is this calling?" → "Just a quick final-expense benefit review — we've already confirmed your eligibility. Let me get you connected with one of our licensed agents. They'll check if that offer's still available — might save you some time and money. Sound good?"
"How much does this cost?" → "A licensed agent gives the exact quote — I just need a few quick answers first."
"I already have coverage." → "Great! We might be able to save you money — just a couple quick questions."
"I'm not interested." → "No problem — just need a few quick questions to confirm and I'll be brief."
"Who are you?" → "I'm with the benefits review team helping seniors check their eligibility — just a few quick questions."
"How did you get my number?" → "You requested information about state-approved benefits — I just need a couple questions."
"I'm busy right now." → "Totally understand — this takes less than one minute, just a couple quick questions."
"Is this a sales call?" → "No — I'm just pre-qualifying you. A licensed agent handles the actual quotes."
"Can you mail me something?" → "Absolutely — I just need to confirm a few details first."
"Can you call me later?" → "Sure — let me just ask the quick qualifying questions so the agent is prepared."
"What company is this?" → "We work with the benefits review team for state-approved final-expense coverage — just a few quick questions."
"I'm too old/sick to qualify." → "You may still qualify — let me ask just a couple quick questions."
"Is this free?" → "Yes — the review is free. Just a couple quick questions."

🚨🚨🚨 CRITICAL SPECIAL CASE - "I don't want it" / "I don't want this" / "I don't want the card" / "I don't want this card" 🚨🚨🚨

⚠️ DO NOT SAY GOODBYE IMMEDIATELY! ⚠️
⚠️ DO NOT END THE CALL YET! ⚠️

FIRST, you MUST ask:
"We may save you time and money — would you like to speak with an agent?"

THEN WAIT for their response:

- If they say YES/YEAH/SURE/OKAY → Continue with workflow (ask verification or qualification questions)
- If they say NO/NAH/NOT INTERESTED → ONLY THEN say goodbye: "I understand. No problem at all. Have a great day!"
                                      AND call: set_call_outcome({outcome: 'user_declined'})

YOU CANNOT SKIP THE QUESTION! You MUST give them the chance to speak with an agent before hanging up!

EXPLICIT HANGUP REQUESTS:
If they say "hang up", "remove me", "don't call again", "take me off your list":
→ Say goodbye naturally: "I understand. No problem at all. Have a great day!"
→ Use the set_call_outcome function with outcome='user_requested_hangup'
→ IMPORTANT: Only speak the goodbye - do NOT mention the function in your spoken response

CONVERSATION STYLE:
- Warm, casual, empathetic - sound 100% human
- Use conversational language: contractions, filler words ("okay", "perfect", "got it")
- Use their first name: ${userInfo.firstname}
- Reference what they said naturally ("you mentioned...", "like you said...")
- YOU called THEM (never say "thanks for calling")
- Keep it brief - don't over-explain
- NEVER say "I'll note that" or "I'll record that" - just move to the next question
- Keep responses SHORT and conversational - no verbose acknowledgments

QUALIFICATION QUESTIONS (ask naturally, one at a time):

1. "Have you ever been diagnosed with Alzheimer's or dementia?"
   → User says "No" → update_qualification({no_alzheimers: true})
   → Your response: "Great! Are you currently in hospice care or a nursing home?"
   
2. "Are you currently in hospice care or a nursing home?"
   → User says "No" → update_qualification({no_hospice: true})
   → Your response: "Perfect! Are you between 50 and 78?"
   
3. "Are you between 50 and 78?"
   → User says "Yes" → update_qualification({age_qualified: true})
   → Your response: "Awesome! Do you have a checking or savings account?"
   
4. "Do you have a checking or savings account?"
   → User says "Yes" → update_qualification({has_bank_account: true})
   → Your response: "Perfect! Let me get you connected with one of our licensed agents..."

CRITICAL: Call the correct function parameter for each specific question!
KEEP RESPONSES SHORT: Just acknowledge briefly (Great!/Perfect!/Awesome!) and ask next question

DISQUALIFICATION RULES (Always confirm disqualifying answers first):
- YES to Alzheimer's/dementia → Confirm, then disqualify
- YES to hospice/nursing home → Confirm, then disqualify
- NO to age 50-78 → Confirm, then disqualify
- NO to bank account → Confirm, then disqualify

DISQUALIFICATION PHRASES (be polite and brief):
- "I appreciate your time, ${userInfo.firstname}. Unfortunately that makes it tough to move forward. But have a great day!"
- "Thanks so much for chatting. Unfortunately [reason] doesn't quite fit for this offer. Take care!"
→ Use set_call_outcome function with outcome='disqualified' (do NOT mention this in your spoken response)

QUALIFIED & READY FOR TRANSFER:
"Perfect! Let me get you connected with one of our licensed agents. They'll check if that offer's still available — might save you some time and money. Sound good?"
→ When they agree, use set_call_outcome function with outcome='transfer_to_agent'

FUNCTION CALLING RULES - CRITICAL:
1. ALWAYS provide BOTH spoken text AND function call in the same response
2. Your spoken text = what the user hears (natural conversation only)
3. Function calls = invisible background actions (never mentioned in speech)
4. ALWAYS call update_qualification when user answers a QUALIFICATION question (Alzheimer's, hospice, age, bank account)
5. 🚨 DO NOT call update_qualification when user responds to the "health issue" discovery question (Step 2) - that's just conversation!
6. For health issue question: Just acknowledge their response and ask the Alzheimer's question - NO function call needed
7. Provide spoken response AND function call in the SAME message - never make 2 messages
8. Use set_call_outcome when ending the call

EXAMPLE OF CORRECT BEHAVIOR:

Example 1: User responds to health issue discovery question (Step 2)
User says: "Yes, I have" (answering "was there a reason you didn't move forward... like maybe a health issue?")
You provide ONLY spoken response (NO function call):
  Spoken: "I understand. Well have you ever been diagnosed with Alzheimer's or dementia?"
  Function: NONE - this is not a qualification question!

Example 2: User responds to Alzheimer's qualification question (Step 3)
User says: "No" (answering Alzheimer's question)
You provide TWO things simultaneously:
  a) Spoken: "Great! Are you currently in hospice care or a nursing home?"
  b) Function: update_qualification({no_alzheimers: true})

🚨 CRITICAL - YOU **MUST** USE THE FUNCTIONS - THIS IS NOT OPTIONAL:

YOU ARE **REQUIRED** TO CALL FUNCTIONS. This is not a suggestion - it's **MANDATORY**.

⚡ **EVERY TIME USER ANSWERS A QUESTION, YOU MUST CALL update_qualification!**

**EXACT PATTERNS - FOLLOW THESE EXACTLY:**

1️⃣ User confirms verification (says "yes"/"yeah"/"right"/"that's right"):
   → IMMEDIATELY call: update_qualification({verified_info: true})
   → Then speak: "Perfect, thanks. So it looks like..."

2️⃣ User answers Alzheimer's question:
   → User says "No" → CALL: update_qualification({no_alzheimers: true})
   → User says "Yes" → CALL: update_qualification({no_alzheimers: false})
   → Then speak: "Great! Are you currently in hospice care..."

3️⃣ User answers hospice question:
   → User says "No" → CALL: update_qualification({no_hospice: true})
   → User says "Yes" → CALL: update_qualification({no_hospice: false})
   → Then speak: "Perfect! Are you between 50 and 78?"

4️⃣ User answers age question:
   → User says "Yes" → CALL: update_qualification({age_qualified: true})
   → User says "No" → CALL: update_qualification({age_qualified: false})
   → Then speak: "Awesome! Do you have a checking or savings account?"

5️⃣ User answers bank account question:
   → User says "Yes" → CALL: update_qualification({has_bank_account: true})
   → User says "No" → CALL: update_qualification({has_bank_account: false})
   → Then speak: "Perfect! Let me get you connected..."

6️⃣ User agrees to transfer:
   → CALL: set_call_outcome({outcome: 'transfer_to_agent'})
   → Then speak: "Awesome! I'm transferring you now."

7️⃣ User declines or fails qualification:
   → CALL: set_call_outcome({outcome: 'disqualified' or 'user_declined'})
   → Then speak: "I understand. Have a great day!"

⚠️ **IF YOU RESPOND WITH ONLY TEXT AND NO FUNCTION CALL, THE SYSTEM WILL BREAK!**
⚠️ **DATA WILL BE LOST IF YOU DON'T CALL FUNCTIONS!**
⚠️ **EVERY ANSWER = FUNCTION CALL. NO EXCEPTIONS!**

WHAT USER HEARS vs WHAT HAPPENS:
User hears: "Perfect! Have you been diagnosed with Alzheimer's?"
Background: update_qualification({verified_info: true}) executes silently

User hears: "I appreciate your time. Have a great day!"
Background: set_call_outcome({outcome: 'disqualified'}) executes silently

NEVER SAY THESE WORDS OR SYMBOLS:
- "call" (as in "call update_qualification")
- "function"
- "update_qualification"
- "set_call_outcome"
- Any plus signs like "+ call"
- Asterisks like "*set_call_outcome*" or "*Transitioning*"
- Technical jargon
- Function names in ANY format

YOUR RESPONSES MUST BE PURE CONVERSATION - NO TECHNICAL TERMS:
GOOD: "Perfect! Have you been diagnosed with Alzheimer's or dementia?"
GOOD: "Awesome! I'm transferring you now. Just a moment."
BAD: "Perfect! Have you been diagnosed... + call update_qualification"
BAD: "Perfect! Have you been diagnosed... (calling function)"
BAD: "Awesome! I'm transferring you now. *set_call_outcome*"
BAD: "*Transitioning you to the agent...*"

CRITICAL: Function calls happen automatically in the background. NEVER mention them, write them, or reference them in your spoken responses!`;

    this.conversationStates.set(callId, {
      userInfo,
      messages: [
        { role: 'system', content: systemPrompt }
      ],
      qualifications: {
        verified_info: null,
        no_alzheimers: null,
        no_hospice: null,
        age_qualified: null,
        has_bank_account: null
      },
      stage: 'greeting',  // Initial stage for silence detection
      startTime: Date.now(),
      greetingSent: false  // Track if greeting has been sent on call answer
    });
  }

  /**
   * Get the next response using conversational AI with function calling
   */
  async getNextResponse(callId, userTranscript = null, confidence = 1.0) {
    const state = this.conversationStates.get(callId);
    if (!state) {
      throw new Error('Conversation not initialized');
    }

    const { userInfo } = state;

    // Add user's response to conversation history
    if (userTranscript) {
      state.messages.push({
        role: 'user',
        content: userTranscript
      });
    }

    // Check if this is the first user response after the initial greeting
    // Messages: [system, assistant(greeting part 1), assistant(greeting part 2), user(first response)]
    const isFirstUserResponse = state.messages.filter(m => m.role === 'user').length === 1;
    
    // If greeting was already sent on call answer, skip sending it again
    // Just proceed to normal AI conversation flow
    if (isFirstUserResponse && !state.greetingSent) {
      // This shouldn't happen if greeting was sent on call answer, but handle it just in case
      console.log('⚠️  First user response but greeting not marked as sent - this should not happen');
    }

    // Prepare tool definitions for structured data extraction (modern tools format)
    const tools = [
      {
        type: 'function',
        function: {
          name: 'update_qualification',
          description: 'REQUIRED: Call this immediately when user answers verification or qualification questions. This tracks their answers.',
          parameters: {
            type: 'object',
            properties: {
              verified_info: {
                type: 'boolean',
                description: 'User confirmed their name and location are correct'
              },
              no_alzheimers: {
                type: 'boolean', 
                description: 'User confirmed they do NOT have Alzheimers or dementia (true = no alzheimers, false = has alzheimers)'
              },
              no_hospice: {
                type: 'boolean',
                description: 'User confirmed they are NOT in hospice or nursing home (true = not in hospice, false = in hospice)'
              },
              age_qualified: {
                type: 'boolean',
                description: 'User confirmed they are between 50-78 years old (true = qualified, false = disqualified)'
              },
              has_bank_account: {
                type: 'boolean',
                description: 'User confirmed they have checking or savings account (true = has account, false = no account)'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'set_call_outcome',
          description: 'REQUIRED: Call this when user agrees/declines transfer or when disqualifying. This ends the call.',
          parameters: {
            type: 'object',
            properties: {
              outcome: {
                type: 'string',
                enum: ['transfer_to_agent', 'disqualified', 'user_declined', 'user_requested_hangup'],
                description: 'The final outcome: transfer_to_agent (qualified and agreed), disqualified (failed qualification), user_declined (declined transfer), user_requested_hangup (asked to end call)'
              },
              reason: {
                type: 'string',
                description: 'Brief reason for the outcome (e.g., "has alzheimers", "not in age range", "no bank account")'
              }
            },
            required: ['outcome']
          }
        }
      }
    ];

    // 🎯 CRITICAL: Detect when we MUST require a function call
    // This forces GPT to call functions for qualification answers
    let toolChoice = 'auto';  // Default: let AI decide
    
    if (userTranscript) {
      const transcript = userTranscript.toLowerCase().trim();
      const lastAssistantMessage = [...state.messages].reverse().find(m => m.role === 'assistant');
      const lastAssistantText = lastAssistantMessage?.content?.toLowerCase() || '';
      
      // Pattern 1: User is clearly answering a yes/no question
      // Match affirmative/negative words, allowing for "uh" prefix and "I do"/"I have" suffix
      // Handles: "yes", "yeah", "uh yeah", "yeah I do", "uh yeah I do", "I do", "I have", etc.
      const trimmedTranscript = transcript.trim();
      const isYesNoAnswer = /^(uh\s+)?(yes|yeah|yep|yup|yess|yea|sure|okay|ok|uh-huh|uh\s+huh|no|nope|nah|naw|right|correct|that's\s+right|that's\s+correct|absolutely|definitely)(\s+(i\s+(do|have)))?\b/i.test(trimmedTranscript) ||
                            /^(i\s+(do|have))\b/i.test(trimmedTranscript);
      
      // Pattern 2: User is stating their age (answering age question)
      const isAgeAnswer = /\b\d{2}\b/.test(transcript) || /\b(fifty|sixty|seventy|eighty|i'm \d{2}|im \d{2})\b/i.test(transcript);
      
      // Pattern 3: User gives affirmative with qualification info
      const hasAgeInResponse = /\b(i'm|im|am) \d{2}|years old|\d{2} years/i.test(transcript);
      const hasBankInResponse = /have (a |an |one|checking|savings)|(got a|got an)/i.test(transcript);
      
      // Pattern 4: AI just asked a qualification question
      const askedVerification = /your last name is.*and you're (over in|in)/i.test(lastAssistantText);
      const askedAlzheimers = /alzheimer|dementia/i.test(lastAssistantText);
      const askedHospice = /hospice|nursing home/i.test(lastAssistantText);
      
      // Pattern 3b: User says "at home" in response to hospice question (handles STT errors like "Though I'm at home")
      const hasAtHomeResponse = askedHospice && /\b(at home|home|living at home|not in hospice|not in nursing)\b/i.test(transcript);
      const askedAge = /between.*50.*78|how old are you/i.test(lastAssistantText);
      const askedBankAccount = /checking|savings|bank account/i.test(lastAssistantText);
      const askedTransfer = /get you connected|speak with.*agent|transfer|sound good/i.test(lastAssistantText);
      
      // 🚨 CRITICAL: Detect the "health issue" discovery question - this is NOT a qualification question!
      // User responses to this question should NOT trigger qualification function calls
      const askedHealthIssue = /preferred final expense offer|didn't move forward|health issue|something else\?/i.test(lastAssistantText);
      
      const askedQualificationQuestion = askedVerification || askedAlzheimers || askedHospice || 
                                         askedAge || askedBankAccount || askedTransfer;
      
      // Pattern 5: User says "I don't want" - should NOT force function call
      // Per system prompt, AI must FIRST ask "We may save you time and money — would you like to speak with an agent?"
      // before ending the call. Forcing a function call here makes the AI skip that required question.
      const isDontWant = /\b(don't want|don't want this|don't want the card|don't want it)\b/i.test(transcript);
      
      // Pattern 5b: Explicit hangup requests - these can go straight to goodbye per prompt
      const isExplicitHangup = /\b(hang up|remove me|don't call again|take me off|stop calling)\b/i.test(transcript);
      
      // Pattern 6: Check if there are unanswered qualifications that should be answered
      const hasUnansweredQualifications = Object.values(state.qualifications).some(v => v === null);
      
      // 🚨 CRITICAL: DO NOT force function call if user is responding to the "health issue" discovery question
      // This is NOT a qualification question - it's just conversation to build rapport
      // User responses like "yes, i have" to the health issue question should NOT trigger qualification calls
      if (askedHealthIssue) {
        console.log('ℹ️  User responding to health issue discovery question - NOT a qualification question, do NOT force function call');
        console.log(`   User said: "${transcript}"`);
        console.log(`   AI should acknowledge and then ask Alzheimer's question`);
      }
      
      // 🔥 FORCE function call if user is answering a qualification question (but NOT the health issue question)
      if ((isYesNoAnswer || isAgeAnswer || hasAgeInResponse || hasBankInResponse || hasAtHomeResponse) && askedQualificationQuestion && !askedHealthIssue) {
        toolChoice = 'required';
        console.log('🎯 FORCING function call - user answering qualification question');
        console.log(`   User said: "${transcript}"`);
        console.log(`   AI asked about: ${askedVerification ? 'verification' : askedAlzheimers ? 'alzheimers' : askedHospice ? 'hospice' : askedAge ? 'age' : askedBankAccount ? 'bank account' : 'transfer'}`);
        if (hasAtHomeResponse) {
          console.log(`   ✅ Detected "at home" response to hospice question - treating as "no" answer`);
        }
      }
      
      // ❌ DO NOT force function call for "I don't want" - AI must ask agent question first per prompt
      // The system prompt explicitly requires asking "We may save you time and money — would you like to speak with an agent?"
      // before ending the call. Let the AI handle this naturally according to the prompt.
      if (isDontWant) {
        console.log('ℹ️  User said "I don\'t want" - letting AI handle per prompt (must ask agent question first)');
      }
      
      // ✅ Allow explicit hangup requests to force function call (per prompt, these can go straight to goodbye)
      if (isExplicitHangup) {
        toolChoice = 'required';
        console.log('🎯 FORCING function call - explicit hangup request');
      }
      
      // 🔥 FORCE function call if conversation is at critical stage with unanswered qualifications
      // This catches cases where AI might skip function calls during qualification flow
      // BUT ONLY if the user's transcript actually looks like an answer!
      // 🚨 CRITICAL: Exclude health issue question - it's NOT a qualification question!
      const looksLikeAnswer = isYesNoAnswer || isAgeAnswer || hasAgeInResponse || hasBankInResponse || hasAtHomeResponse;
      
      if (hasUnansweredQualifications && state.qualifications.verified_info === true && askedQualificationQuestion && looksLikeAnswer && !askedHealthIssue) {
        if (toolChoice !== 'required') {
          toolChoice = 'required';
          console.log('🎯 FORCING function call - critical qualification stage');
          console.log(`   Unanswered qualifications detected`);
          console.log(`   User transcript looks like an answer: "${transcript}"`);
        }
      } else if (hasUnansweredQualifications && state.qualifications.verified_info === true && askedQualificationQuestion && !looksLikeAnswer && !askedHealthIssue) {
        // Log when we would force but transcript doesn't look like an answer
        console.log('ℹ️  Skipping forced function call - transcript does not look like an answer');
        console.log(`   Transcript: "${transcript}"`);
        console.log(`   AI asked: ${askedVerification ? 'verification' : askedAlzheimers ? 'alzheimers' : askedHospice ? 'hospice' : askedAge ? 'age' : askedBankAccount ? 'bank account' : 'transfer'}`);
      } else if (askedHealthIssue && hasUnansweredQualifications) {
        console.log('ℹ️  User responding to health issue discovery question - this is conversation, not qualification');
        console.log(`   AI should acknowledge response and ask Alzheimer's question next`);
      }
    }

    try {
      // Call OpenAI with full conversation history and function calling
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: state.messages,
        tools: tools,
        tool_choice: toolChoice,  // 'auto' or 'required' based on context
        temperature: 0.3,  // Lower temperature for more consistent function calling
        max_tokens: 150,
        parallel_tool_calls: false  // One tool call at a time for clarity
      });

      // Track OpenAI usage
      if (response.usage) {
        costTracking.trackOpenAIUsage(
          callId,
          'gpt-4o-mini',
          response.usage.prompt_tokens,
          response.usage.completion_tokens,
          'conversation'
        );
      }

      const message = response.choices[0].message;
      
      // 🔍 DIAGNOSTIC: Log what AI returned
      console.log('🔍 AI Response Details:');
      console.log('   - Has content:', !!message.content);
      console.log('   - Has tool_calls:', !!message.tool_calls);
      console.log('   - Has function_call:', !!message.function_call);
      if (message.tool_calls) {
        console.log('   - Tool calls:', JSON.stringify(message.tool_calls, null, 2));
      }
      if (message.function_call) {
        console.log('   - Function call:', JSON.stringify(message.function_call, null, 2));
      }
      
      // Handle tool calls (newer format) or function calls (legacy)
      let shouldHangup = false;
      let shouldTransfer = false;
      let functionCallProcessed = false;
      
      // Check for tool calls (newer format)
      const toolCalls = message.tool_calls;
      const functionCall = toolCalls?.[0] || message.function_call;
      
      if (toolCalls && toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);
        
        console.log(`Function called: ${functionName}`, functionArgs);
        
        if (functionName === 'update_qualification') {
          // Update qualification status
          Object.keys(functionArgs).forEach(key => {
            if (functionArgs[key] !== undefined && functionArgs[key] !== null) {
              state.qualifications[key] = functionArgs[key];
            }
          });
          console.log('Updated qualifications:', state.qualifications);
          functionCallProcessed = true;
        } else if (functionName === 'set_call_outcome') {
          // 🔧 FIX: If user just answered bank account question but qualification wasn't updated, update it now
          const lastAIMessage = [...state.messages].reverse().find(m => m.role === 'assistant');
          const lastAIText = (lastAIMessage?.content || '').toLowerCase();
          const askedBankAccount = /checking|savings|bank account/i.test(lastAIText);
          
          if (askedBankAccount && state.qualifications.has_bank_account === null && functionArgs.outcome === 'transfer_to_agent') {
            // User answered bank account question but qualification wasn't updated - fix it now
            console.log('🔧 FIX: Bank account qualification was not updated - updating now before transfer');
            state.qualifications.has_bank_account = true;
            console.log('   ✅ Set has_bank_account = true');
          }
          
          console.log(`Call outcome: ${functionArgs.outcome}`, functionArgs.reason || '');
          
          if (functionArgs.outcome === 'transfer_to_agent') {
            // 🔥 CRITICAL: Check if user is fully qualified before allowing transfer
            const quals = state.qualifications;
            const isFullyQualified = quals.verified_info === true && 
                                     quals.no_alzheimers === true && 
                                     quals.no_hospice === true && 
                                     quals.age_qualified === true && 
                                     quals.has_bank_account === true;
            
            if (!isFullyQualified) {
              console.log('⚠️  AI attempted transfer but user is NOT fully qualified - blocking transfer');
              console.log(`   Qualifications: verified=${quals.verified_info}, alzheimers=${quals.no_alzheimers}, hospice=${quals.no_hospice}, age=${quals.age_qualified}, bank=${quals.has_bank_account}`);
              // Don't transfer - continue with qualification questions
              // Regenerate response to ask the missing qualification question
              const nextQuestion = this._getNextQuestion(state);
              if (nextQuestion) {
                assistantResponse = nextQuestion;
                console.log('   ✅ Regenerated response to ask missing qualification question');
              } else {
                assistantResponse = `Got it, thanks!`;
              }
              // Don't set shouldTransfer = true - will continue asking questions
            } else {
              shouldTransfer = true;
            }
          } else {
            shouldHangup = true;
          }
          functionCallProcessed = true;
        }
      } else if (message.function_call) {
        // Legacy function call format
        const functionName = message.function_call.name;
        const functionArgs = JSON.parse(message.function_call.arguments);
        
        console.log(`Function called: ${functionName}`, functionArgs);
        
        if (functionName === 'update_qualification') {
          // Update qualification status
          Object.keys(functionArgs).forEach(key => {
            if (functionArgs[key] !== undefined && functionArgs[key] !== null) {
              state.qualifications[key] = functionArgs[key];
            }
          });
          console.log('Updated qualifications:', state.qualifications);
          functionCallProcessed = true;
        } else if (functionName === 'set_call_outcome') {
          // 🔧 FIX: If user just answered bank account question but qualification wasn't updated, update it now
          const lastAIMessage = [...state.messages].reverse().find(m => m.role === 'assistant');
          const lastAIText = (lastAIMessage?.content || '').toLowerCase();
          const askedBankAccount = /checking|savings|bank account/i.test(lastAIText);
          
          if (askedBankAccount && state.qualifications.has_bank_account === null && functionArgs.outcome === 'transfer_to_agent') {
            // User answered bank account question but qualification wasn't updated - fix it now
            console.log('🔧 FIX: Bank account qualification was not updated - updating now before transfer');
            state.qualifications.has_bank_account = true;
            console.log('   ✅ Set has_bank_account = true');
          }
          
          console.log(`Call outcome: ${functionArgs.outcome}`, functionArgs.reason || '');
          
          if (functionArgs.outcome === 'transfer_to_agent') {
            // 🔥 CRITICAL: Check if user is fully qualified before allowing transfer
            const quals = state.qualifications;
            const isFullyQualified = quals.verified_info === true && 
                                     quals.no_alzheimers === true && 
                                     quals.no_hospice === true && 
                                     quals.age_qualified === true && 
                                     quals.has_bank_account === true;
            
            if (!isFullyQualified) {
              console.log('⚠️  AI attempted transfer but user is NOT fully qualified - blocking transfer');
              console.log(`   Qualifications: verified=${quals.verified_info}, alzheimers=${quals.no_alzheimers}, hospice=${quals.no_hospice}, age=${quals.age_qualified}, bank=${quals.has_bank_account}`);
              // Don't transfer - continue with qualification questions
              // Regenerate response to ask the missing qualification question
              const nextQuestion = this._getNextQuestion(state);
              if (nextQuestion) {
                assistantResponse = nextQuestion;
                console.log('   ✅ Regenerated response to ask missing qualification question');
              } else {
                assistantResponse = `Got it, thanks!`;
              }
              // Don't set shouldTransfer = true - will continue asking questions
            } else {
              shouldTransfer = true;
            }
          } else {
            shouldHangup = true;
          }
          functionCallProcessed = true;
        }
      }

      // 🔥 CRITICAL: Auto-detect disqualification and trigger hangup
      // This ensures hangup happens even if AI doesn't call set_call_outcome
      const quals = state.qualifications;
      if (quals.no_alzheimers === false || quals.no_hospice === false || 
          quals.age_qualified === false || quals.has_bank_account === false) {
        // User was disqualified - force hangup
        if (!shouldHangup && !shouldTransfer) {
          console.log('🚨 Disqualification detected - forcing hangup');
          console.log(`   Qualifications: alzheimers=${quals.no_alzheimers}, hospice=${quals.no_hospice}, age=${quals.age_qualified}, bank=${quals.has_bank_account}`);
          shouldHangup = true;
        }
      }

      // 🔥 CRITICAL: Auto-detect full qualification and trigger transfer
      // This ensures transfer happens even if AI doesn't call set_call_outcome
      // Check if all 5 qualifications are true (user is fully qualified)
      const isFullyQualified = quals.verified_info === true && 
                               quals.no_alzheimers === true && 
                               quals.no_hospice === true && 
                               quals.age_qualified === true && 
                               quals.has_bank_account === true;
      
      // Safety check: Ensure conversation has progressed past greeting stage
      // and that bank account question (last qualification) has been answered
      const hasProgressedPastGreeting = state.stage !== 'greeting' && state.messages.length > 1;
      const bankAccountAnswered = quals.has_bank_account === true;
      
      // 🔧 FIX: Check if AI just asked "Sound good?" - if so, wait for user's response before transferring
      const lastAIMessage = [...state.messages].reverse().find(m => m.role === 'assistant');
      const lastAIText = (lastAIMessage?.content || '').toLowerCase();
      const justAskedSoundGood = /sound good/i.test(lastAIText) && /get you connected|licensed agent/i.test(lastAIText);
      
      // 🔧 FIX: Detect user's response to "Sound good?" question
      if (justAskedSoundGood && isFullyQualified && userTranscript) {
        const transcriptLower = userTranscript.toLowerCase().trim();
        const userSaidYes = /^(yes|yeah|yep|yup|yess|yea|sure|okay|ok|sounds good|sounds great|that sounds good|that sounds great|that's good|that's great)\b/i.test(transcriptLower);
        const userSaidNo = /^(no|nope|nah|naw|not yet|not right now|maybe later|not interested|i don't want|i don't need)\b/i.test(transcriptLower);
        
        if (userSaidYes && !shouldTransfer) {
          // User confirmed transfer - set shouldTransfer so AI can confirm and then transfer
          console.log('✅ User confirmed transfer after "Sound good?" - setting shouldTransfer');
          shouldTransfer = true;
        } else if (userSaidNo && !shouldHangup) {
          // User declined transfer - set shouldHangup so AI can say goodbye
          console.log('✅ User declined transfer after "Sound good?" - setting shouldHangup');
          shouldHangup = true;
        }
      }
      
      if (isFullyQualified && !shouldHangup && !shouldTransfer && hasProgressedPastGreeting && bankAccountAnswered && !justAskedSoundGood) {
        // User is fully qualified and AI hasn't asked "Sound good?" yet - ask for confirmation
        console.log('✅ Full qualification detected - will ask for transfer confirmation');
        console.log(`   Qualifications: verified=${quals.verified_info}, alzheimers=${quals.no_alzheimers}, hospice=${quals.no_hospice}, age=${quals.age_qualified}, bank=${quals.has_bank_account}`);
        console.log(`   Conversation stage: ${state.stage}, Messages: ${state.messages.length}`);
        // DON'T set shouldTransfer = true yet - wait for user's response to "Sound good?"
      } else if (isFullyQualified && justAskedSoundGood && !shouldTransfer && !shouldHangup) {
        // AI just asked "Sound good?" - waiting for user's response (handled above)
        console.log('⏳ Waiting for user response to "Sound good?" question');
      } else if (isFullyQualified && !shouldTransfer && !justAskedSoundGood) {
        // Log when user is qualified but transfer wasn't triggered (for debugging)
        console.log('⚠️  User is fully qualified but transfer not triggered');
        console.log(`   Qualifications: verified=${quals.verified_info}, alzheimers=${quals.no_alzheimers}, hospice=${quals.no_hospice}, age=${quals.age_qualified}, bank=${quals.has_bank_account}`);
        console.log(`   Current state: shouldHangup=${shouldHangup}, shouldTransfer=${shouldTransfer}`);
        console.log(`   Safety checks: hasProgressedPastGreeting=${hasProgressedPastGreeting}, bankAccountAnswered=${bankAccountAnswered}, stage=${state.stage}`);
      }

      // Get the assistant's response
      let assistantResponse = message.content || '';
      
      // 🛡️ SAFETY FILTER: Remove any accidental function name mentions
      // This ensures users NEVER hear technical jargon, even if AI makes a mistake
      if (assistantResponse) {
        const originalResponse = assistantResponse;
        
        // List of forbidden phrases that should never be spoken
        const forbiddenPatterns = [
          /\bupdate_qualification\b/gi,
          /\bset_call_outcome\b/gi,
          /\bcall\s+update_qualification/gi,
          /\bcall\s+set_call_outcome/gi,
          /\(calling function\)/gi,
          /\+ call\b/gi,
          /\*set_call_outcome\*/gi,
          /\*update_qualification\*/gi,
          /\*Transitioning\*/gi,
          /\{[^}]*outcome[^}]*\}/gi,  // Remove JSON-like structures
          /function\s*:/gi,
          /tool_calls/gi,
        ];
        
        // Remove forbidden phrases
        forbiddenPatterns.forEach(pattern => {
          assistantResponse = assistantResponse.replace(pattern, '');
        });
        
        // Clean up any resulting double spaces or awkward punctuation
        assistantResponse = assistantResponse
          .replace(/\s+/g, ' ')  // Multiple spaces to single space
          .replace(/\s+([.,!?])/g, '$1')  // Remove space before punctuation
          .replace(/\s*\(\s*\)/g, '')  // Remove empty parentheses
          .replace(/\s*\[\s*\]/g, '')  // Remove empty brackets
          .trim();
        
        // Log if we filtered anything out
        if (originalResponse !== assistantResponse) {
          console.log('⚠️  FILTERED OUT FUNCTION NAMES FROM SPOKEN RESPONSE');
          console.log(`   Original: "${originalResponse}"`);
          console.log(`   Cleaned: "${assistantResponse}"`);
        }
      }
      
      // If tool/function was called but no content, generate a smart template response
      // This avoids a second API call and reduces latency by 50%
      if (!assistantResponse && (toolCalls || message.function_call)) {
        const activeTool = toolCalls?.[0] || message.function_call;
        const functionName = activeTool.function?.name || activeTool.name;
        const functionArgs = JSON.parse(activeTool.function?.arguments || activeTool.arguments);
        
        // Generate smart template response based on qualification state
        if (functionName === 'update_qualification') {
          // Use helper function to get next question (checks if already asked)
          const nextQuestion = this._getNextQuestion(state);
          
          if (nextQuestion) {
            assistantResponse = nextQuestion;
          } else {
            // Check if user was disqualified - use appropriate goodbye message
            const quals = state.qualifications;
            const isDisqualified = quals.no_alzheimers === false || 
                                  quals.no_hospice === false || 
                                  quals.age_qualified === false || 
                                  quals.has_bank_account === false;
            
            if (isDisqualified) {
              // User was disqualified - use polite goodbye
              assistantResponse = `I understand. No problem at all. Have a great day!`;
            } else {
              // Fallback if no next question found (shouldn't normally happen)
              assistantResponse = `Got it, thanks!`;
            }
          }
        } else if (functionName === 'set_call_outcome') {
          if (functionArgs.outcome === 'transfer_to_agent') {
            assistantResponse = `Great! Just a minute, I will connect you to a licensed agent.`;
          } else {
            assistantResponse = `I understand. No problem at all. Have a great day!`;
          }
        }
        
        console.log('⚡ Generated instant template response (no 2nd API call)');
      }

      // 🛡️ FALLBACK: If tool_choice was 'required' but no function was called, manually infer the qualification
      // This is a safety net for when forced function calling still fails
      if (toolChoice === 'required' && !functionCallProcessed && userTranscript) {
        console.log('⚠️  Function call was REQUIRED but not made - attempting manual inference');
        const transcript = userTranscript.toLowerCase().trim();
        const lastAssistantMessage = [...state.messages].reverse().find(m => m.role === 'assistant');
        const lastAssistantText = lastAssistantMessage?.content?.toLowerCase() || '';
        
        // Try to infer what qualification should be updated based on context
        let manuallyUpdated = false;
        
        if (/your last name is.*and you're (over in|in)/i.test(lastAssistantText)) {
          // Verification question - check for affirmative
          if (/^(yes|yeah|yep|yup|yess|yea|right|correct|that's right|that's correct|absolutely|definitely)\b/i.test(transcript)) {
            state.qualifications.verified_info = true;
            console.log('   ✅ Manually set verified_info = true');
            manuallyUpdated = true;
          }
        } else if (/alzheimer|dementia/i.test(lastAssistantText)) {
          // Alzheimer's question
          if (/^(no|nope|nah|naw)\b/i.test(transcript)) {
            state.qualifications.no_alzheimers = true;
            console.log('   ✅ Manually set no_alzheimers = true');
            manuallyUpdated = true;
          } else if (/^(yes|yeah|yep|yup|yess|yea|absolutely|definitely)\b/i.test(transcript) || 
                     /^(i have|i do|yes i have|yeah i have|yep i have)\b/i.test(transcript)) {
            state.qualifications.no_alzheimers = false;
            console.log('   ✅ Manually set no_alzheimers = false');
            manuallyUpdated = true;
          }
        } else if (/hospice|nursing home/i.test(lastAssistantText)) {
          // Hospice question - improved to catch "no, I mean at home" type answers
          // Check for "at home" anywhere in response (handles STT errors like "Though I'm at home")
          const hasAtHome = /\b(at home|home|living at home|not in hospice|not in nursing)\b/i.test(transcript);
          const startsWithNo = /^(no|nope|nah|naw)\b/i.test(transcript);
          const hasNoAtStart = /^no[,.]?\s*(i mean|i'm|im|i am|we are|we're)\s*(at home|home|living at home|not in hospice|not in nursing)/i.test(transcript);
          const startsWithImAtHome = /^(i'm|im|i am|we are|we're)\s*(at home|home|living at home|not in hospice|not in nursing)/i.test(transcript);
          const hasNoWithLocation = /^(no|nope|nah|naw)[,.]?\s*(i|we)\s*(mean|live|are|stay)\s*(at home|home)/i.test(transcript);
          
          if (startsWithNo || hasNoAtStart || startsWithImAtHome || hasNoWithLocation || hasAtHome) {
            state.qualifications.no_hospice = true;
            console.log('   ✅ Manually set no_hospice = true (detected "no" or "at home" response)');
            console.log(`   📝 Transcript: "${transcript}" - matched pattern: ${startsWithNo ? 'startsWithNo' : hasNoAtStart ? 'hasNoAtStart' : startsWithImAtHome ? 'startsWithImAtHome' : hasNoWithLocation ? 'hasNoWithLocation' : 'hasAtHome'}`);
            manuallyUpdated = true;
          } else if (/^(yes|yeah|yep|yup|yess|yea|absolutely|definitely|i have|i do|i am|i'm in|we are in|we're in)\b/i.test(transcript) ||
                     /^(yes|yeah|yep|yup|yess|yea)[,.]?\s*(i|we)\s*(am|are|have|do)\s*(in hospice|in nursing)/i.test(transcript)) {
            state.qualifications.no_hospice = false;
            console.log('   ✅ Manually set no_hospice = false (detected "yes" to hospice/nursing home)');
            manuallyUpdated = true;
          }
        } else if (/between.*50.*78|how old are you/i.test(lastAssistantText)) {
          // Age question
          const hasAge = /\b\d{2}\b/.test(transcript);
          if (/^(yes|yeah|yep|yup|yess|yea|absolutely|definitely)\b/i.test(transcript) || hasAge) {
            state.qualifications.age_qualified = true;
            console.log('   ✅ Manually set age_qualified = true');
            manuallyUpdated = true;
          } else if (/^(no|nope|nah|naw)\b/i.test(transcript)) {
            state.qualifications.age_qualified = false;
            console.log('   ✅ Manually set age_qualified = false');
            manuallyUpdated = true;
          }
        } else if (/checking|savings|bank account/i.test(lastAssistantText)) {
          // Bank account question
          if (/^(yes|yeah|yep|yup|yess|yea|absolutely|definitely|i have|i do|have (a |an |one))/i.test(transcript)) {
            state.qualifications.has_bank_account = true;
            console.log('   ✅ Manually set has_bank_account = true');
            manuallyUpdated = true;
          } else if (/^no\b|^nope\b|^nah\b/i.test(transcript)) {
            state.qualifications.has_bank_account = false;
            console.log('   ✅ Manually set has_bank_account = false');
            manuallyUpdated = true;
          }
        }
        
        if (manuallyUpdated) {
          console.log('   📊 Updated qualifications (manual fallback):', state.qualifications);
          
          // 🔧 FIX: Regenerate response based on updated qualification state
          // This ensures the response matches the new state after manual fallback
          const quals = state.qualifications;
          
          // Use helper function to get next question (checks if already asked)
          const nextQuestion = this._getNextQuestion(state);
          
          if (nextQuestion) {
            assistantResponse = nextQuestion;
          } else if (quals.has_bank_account === false || quals.age_qualified === false || quals.no_hospice === false || quals.no_alzheimers === false) {
            // User was disqualified
            assistantResponse = `I appreciate your time. Unfortunately that doesn't quite fit for this offer. Have a great day!`;
            shouldHangup = true;
          } else {
            assistantResponse = `Got it, thanks!`;
          }
          
          console.log('   ✅ Regenerated response based on updated qualifications');
        }
      }

      // Add assistant's response to history
      if (assistantResponse) {
        state.messages.push({
          role: 'assistant',
          content: assistantResponse
        });
      }

      // Safety check: If AI says goodbye but didn't call function, force hangup
      const goodbyePhrases = [
        'have a great day',
        'have a good day',
        'take care',
        'goodbye',
        'bye',
        'thanks for your time'
      ];
      
      const responseL = assistantResponse.toLowerCase();
      const saysGoodbye = goodbyePhrases.some(phrase => responseL.includes(phrase));
      
      if (saysGoodbye && !shouldHangup && !shouldTransfer) {
        console.log('⚠️  AI said goodbye but did not call set_call_outcome - forcing hangup');
        shouldHangup = true;
      }

      // Safety check: If AI says transfer but didn't call function, force hangup to avoid confusion
      // Only trigger on explicit transfer statements (not offers to connect that ask for confirmation)
      const explicitTransferPhrases = [
        'transferring you now',
        "i'm transferring you",
        "im transferring you",
        'transferring now',
        'i am transferring',
        'transferring you right now',
        'i\'m connecting you now',
        'connecting you now'
      ];
      
      const saysExplicitTransfer = explicitTransferPhrases.some(phrase => responseL.includes(phrase));
      
      // Check for "get you connected" but only if it's NOT asking for confirmation
      // If it says "let me get you connected" with "sound good?" it's asking for agreement - that's OK
      const connectingPhrase = responseL.includes('get you connected') && 
                              !responseL.includes('sound good') && 
                              !responseL.includes('?');
      
      // 🔧 FIX: Handle user's confirmation response to "Sound good?" question
      // Re-check if AI just asked "Sound good?" (in case assistant response changed)
      const lastAIMessageAfter = [...state.messages].reverse().find(m => m.role === 'assistant');
      const lastAITextAfter = (lastAIMessageAfter?.content || '').toLowerCase();
      const justAskedSoundGoodAfter = /sound good/i.test(lastAITextAfter) && /get you connected|licensed agent/i.test(lastAITextAfter);
      
      // If user confirmed transfer (shouldTransfer was set above), generate/override confirmation response
      if (shouldTransfer && justAskedSoundGoodAfter) {
        // User confirmed transfer - generate confirmation message (override if AI didn't generate appropriate one)
        if (!assistantResponse || !assistantResponse.toLowerCase().includes('connect') && !assistantResponse.toLowerCase().includes('transfer')) {
          assistantResponse = `Great! Just a minute, I will connect you to a licensed agent.`;
          console.log('✅ User confirmed transfer - generating confirmation response');
        }
      } else if (shouldHangup && justAskedSoundGoodAfter) {
        // User declined transfer - generate goodbye message (override if AI didn't generate appropriate one)
        if (!assistantResponse || !assistantResponse.toLowerCase().includes('good day') && !assistantResponse.toLowerCase().includes('bye')) {
          assistantResponse = `Got it, I understand. You can call with a licensed agent anytime. Have a good day. Bye!`;
          console.log('✅ User declined transfer - generating goodbye response');
        }
      }
      
      if ((saysExplicitTransfer || connectingPhrase) && !shouldTransfer && !shouldHangup) {
        // Check if user is fully qualified - if so, trigger transfer instead of hangup
        const quals = state.qualifications;
        const isFullyQualified = quals.verified_info === true && 
                                 quals.no_alzheimers === true && 
                                 quals.no_hospice === true && 
                                 quals.age_qualified === true && 
                                 quals.has_bank_account === true;
        
        if (isFullyQualified) {
          // User is qualified - AI should transfer, so trigger transfer instead of hangup
          console.log('⚠️  AI said transfer but did not call set_call_outcome - user is qualified, triggering transfer');
          console.log(`   Response was: "${assistantResponse}"`);
          shouldTransfer = true;
          // Keep the original response since user is qualified and should be transferred
        } else {
          // User is not qualified - AI shouldn't be transferring, so hangup
          console.log('⚠️  AI said transfer but did not call set_call_outcome - user not qualified, forcing hangup');
          console.log(`   Response was: "${assistantResponse}"`);
          shouldHangup = true;
          // Override response to avoid promising transfer that won't happen
          assistantResponse = "I understand. Let me have someone reach out to you. Have a great day!";
        }
      }

      // 🔄 CRITICAL FIX: Update state.stage to reflect current qualification progress
      // This ensures the stage is tracked properly throughout the conversation
      const currentStage = this.determineStage(state.qualifications);
      state.stage = currentStage;  // Update internal state
      console.log(`📊 Updated conversation stage: ${currentStage}`);
      console.log(`   Qualifications: verified=${state.qualifications.verified_info}, alzheimers=${state.qualifications.no_alzheimers}, hospice=${state.qualifications.no_hospice}, age=${state.qualifications.age_qualified}, bank=${state.qualifications.has_bank_account}`);

      return {
        response: assistantResponse,
        stage: currentStage,
        shouldHangup,
        shouldTransfer,
        qualificationAnswers: state.qualifications
      };

    } catch (error) {
      console.error('Error getting AI response:', error);
      
      // Fallback response
      return {
        response: "I apologize, could you repeat that for me?",
        stage: 'error',
        shouldHangup: false,
        shouldTransfer: false,
        qualificationAnswers: state.qualifications
      };
    }
  }

  /**
   * Determine current stage based on qualifications
   */
  determineStage(qualifications) {
    // Check if any qualification failed
    const hasFailed = Object.values(qualifications).some(v => v === false);
    
    // Check if all qualifications are answered
    const allAnswered = Object.values(qualifications).every(v => v !== null);
    
    // Check if all passed (all true)
    const allPassed = Object.values(qualifications).every(v => v === true);
    
    if (hasFailed) {
      return 'disqualified';
    } else if (allAnswered && allPassed) {
      return 'qualified';
    } else if (qualifications.verified_info === true) {
      return 'qualifying';
    } else if (qualifications.verified_info === false) {
      return 'verification_failed';
    } else {
      return 'verification';
    }
  }

  /**
   * End conversation and cleanup
   */
  endConversation(callId) {
    const state = this.conversationStates.get(callId);
    if (state) {
      const duration = Date.now() - state.startTime;
      console.log(`Conversation ended. Duration: ${(duration / 1000).toFixed(1)}s`);
      console.log(`Final qualifications:`, state.qualifications);
    }
    this.conversationStates.delete(callId);
  }

  /**
   * Get conversation state (for debugging)
   */
  getConversationState(callId) {
    return this.conversationStates.get(callId);
  }

  /**
   * Get greeting message (instant, no AI call)
   * Returns the first part of the split greeting
   */
  getGreeting(callId) {
    const state = this.conversationStates.get(callId);
    if (!state) {
      throw new Error('Conversation not initialized');
    }

    // 🛡️ GUARD: Prevent greeting from being sent twice
    if (state.greetingSent) {
      console.log('⚠️  Greeting already sent - returning existing greeting to prevent duplicate');
      // Find the existing greeting in conversation history
      const existingGreeting = state.messages.find(m => 
        m.role === 'assistant' && 
        m.content && 
        m.content.includes('Nice to meet you, this is Mia')
      );
      if (existingGreeting) {
        return existingGreeting.content;
      }
    }

    const { userInfo } = state;
    
    // First part of split greeting (instant, no AI call needed)
    const greeting = `${userInfo.firstname} Nice to meet you, this is Mia with the Benefits Review Team.`;
    
    // Add to conversation history
    state.messages.push({
      role: 'assistant',
      content: greeting
    });
    
    // Mark greeting as sent
    state.greetingSent = true;

    return greeting;
  }

  /**
   * Get second part of greeting (instant, no AI call)
   */
  getGreetingSecondPart(callId) {
    const state = this.conversationStates.get(callId);
    if (!state) {
      throw new Error('Conversation not initialized');
    }

    // 🛡️ GUARD: Check if second greeting was already sent
    // Look for the second greeting in conversation history
    const existingSecondGreeting = state.messages.find(m => 
      m.role === 'assistant' && 
      m.content && 
      m.content.includes("I'm just following up on your request for final expense coverage")
    );
    
    if (existingSecondGreeting) {
      console.log('⚠️  Second greeting already sent - returning existing to prevent duplicate');
      return existingSecondGreeting.content;
    }

    const { userInfo } = state;
    
    // Second part of split greeting
    const secondPart = `I'm just following up on your request for final expense coverage to help cover the burial or cremation costs. Your last name is ${userInfo.lastname} and you're over in ${userInfo.address}, right?`;
    
    // Add to conversation history
    state.messages.push({
      role: 'assistant',
      content: secondPart
    });

    return secondPart;
  }

  /**
   * Get verification message (instant, no AI call)
   */
  getVerification(callId) {
    const state = this.conversationStates.get(callId);
    if (!state) {
      throw new Error('Conversation not initialized');
    }

    const { userInfo } = state;
    
    // Instant verification (no AI call needed)
    const verification = `So you listed your last name as ${userInfo.lastname} and you're over in ${userInfo.address}... that sound right?`;
    
    // Add to conversation history
    state.messages.push({
      role: 'assistant',
      content: verification
    });

    return verification;
  }

  /**
   * Check if a specific question was already asked in conversation history
   */
  _questionAlreadyAsked(state, questionPattern) {
    return state.messages.some(msg => 
      msg.role === 'assistant' && 
      msg.content &&
      questionPattern.test(msg.content)
    );
  }

  /**
   * Get the next question to ask based on qualification state
   * Only returns a question if:
   * 1. Previous qualification is true (or verified_info is true for first question)
   * 2. Current qualification is null (not answered)
   * 3. Question hasn't been asked yet
   */
  _getNextQuestion(state) {
    const quals = state.qualifications;
    
    // Check which questions were already asked
    const healthIssueAsked = this._questionAlreadyAsked(
      state, 
      /preferred final expense offer|didn't move forward|health issue|something else\?/i
    );
    
    const alzheimersAsked = this._questionAlreadyAsked(
      state,
      /alzheimer|dementia/i
    );
    
    const hospiceAsked = this._questionAlreadyAsked(
      state,
      /hospice|nursing home/i
    );
    
    const ageAsked = this._questionAlreadyAsked(
      state,
      /between.*50.*78|how old are you/i
    );
    
    const bankAccountAsked = this._questionAlreadyAsked(
      state,
      /checking|savings|bank account/i
    );
    
    // STEP 2: Health issue discovery question
    // Only ask if: verified_info is true AND no_alzheimers is null AND not asked yet
    if (quals.verified_info === true && quals.no_alzheimers === null) {
      if (!healthIssueAsked) {
        return `Perfect, thanks. So it looks like you had a preferred final expense offer that wasn't claimed yet. We might be able to reopen it. Was there a reason you didn't move forward last time... like maybe a health issue or something else?`;
      } else if (!alzheimersAsked) {
        // Health issue was asked, now ask Alzheimer's
        return `I understand. Well have you ever been diagnosed with Alzheimer's or dementia?`;
      }
    }
    
    // STEP 3: Qualification questions
    // Question 1: Alzheimer's
    // Only ask if: verified_info is true AND no_alzheimers is null AND not asked yet
    if (quals.verified_info === true && quals.no_alzheimers === null && !alzheimersAsked) {
      return `Have you ever been diagnosed with Alzheimer's or dementia?`;
    }
    
    // Question 2: Hospice
    // Only ask if: no_alzheimers is true AND no_hospice is null AND not asked yet
    if (quals.no_alzheimers === true && quals.no_hospice === null && !hospiceAsked) {
      return `Great! Are you currently in hospice care or a nursing home?`;
    }
    
    // Question 3: Age
    // Only ask if: no_hospice is true AND age_qualified is null AND not asked yet
    if (quals.no_hospice === true && quals.age_qualified === null && !ageAsked) {
      return `Perfect! Are you between 50 and 78?`;
    }
    
    // Question 4: Bank Account
    // Only ask if: age_qualified is true AND has_bank_account is null AND not asked yet
    if (quals.age_qualified === true && quals.has_bank_account === null && !bankAccountAsked) {
      return `Awesome! Do you have a checking or savings account?`;
    }
    
    // All questions answered - ready for transfer
    if (quals.has_bank_account === true) {
      return `Perfect! Let me get you connected with one of our licensed agents. They'll check if that offer's still available — might save you some time and money. Sound good?`;
    }
    
    return null; // No next question
  }
}

module.exports = new OpenAIService();
