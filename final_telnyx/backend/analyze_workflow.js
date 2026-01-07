/**
 * Comprehensive analysis of call conversation history against workflow
 * Checks if all calls follow the expected workflow steps:
 * 1. Verification (update_qualification with verified_info: true)
 * 2. Discovery question (about previous offer - NO qualification call)
 * 3. Qualification questions (update_qualification for each: no_alzheimers, no_hospice, age_qualified, has_bank_account)
 * 4. Transfer (set_call_outcome with transfer_to_agent)
 */

// Load environment variables if .env exists
try {
  const path = require('path');
  // Try loading from backend directory first (where .env usually is)
  require('dotenv').config({ path: path.join(__dirname, 'backend', '.env') });
  // Also try root directory as fallback
  require('dotenv').config();
} catch (e) {
  // dotenv not available, environment variables should be set externally
}

const { query } = require('./config/database');

// Expected workflow steps
const WORKFLOW_STEPS = {
  VERIFICATION: 'verification',
  DISCOVERY: 'discovery',
  QUALIFICATION_ALZHEIMERS: 'qualification_alzheimers',
  QUALIFICATION_HOSPICE: 'qualification_hospice',
  QUALIFICATION_AGE: 'qualification_age',
  QUALIFICATION_BANK: 'qualification_bank',
  TRANSFER: 'transfer'
};

async function analyzeAllConversations() {
  try {
    console.log('🔍 Starting comprehensive workflow compliance analysis...\n');
    console.log('📋 This analysis will check:');
    console.log('   1. Verification step (update_qualification with verified_info: true)');
    console.log('   2. Discovery question (about previous offer - should NOT call update_qualification)');
    console.log('   3. Qualification questions (update_qualification for each: no_alzheimers, no_hospice, age_qualified, has_bank_account)');
    console.log('   4. Transfer step (set_call_outcome with transfer_to_agent)\n');

    // Get all conversations from database
    console.log('📊 Fetching all conversations from database...');
    console.log('   (Make sure DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD are set in .env or environment)\n');
    
    let allCalls;
    try {
      allCalls = await query(`
        SELECT 
          c.id,
          c.call_control_id,
          c.from_number,
          c.to_number,
          c.start_time,
          c.end_time,
          c.duration,
          c.status,
          c.hangup_cause,
          c.messages,
          c.cost_breakdown,
          c.created_at
        FROM conversations c
        ORDER BY c.start_time DESC
      `);
    } catch (dbError) {
      console.error('❌ Database connection failed!');
      console.error(`   Error: ${dbError.message}`);
      console.error('\n💡 To fix this:');
      console.error('   1. Make sure PostgreSQL is running');
      console.error('   2. Create a .env file in the backend directory with:');
      console.error('      DB_HOST=localhost');
      console.error('      DB_PORT=5432');
      console.error('      DB_NAME=telnyx_voice_ai');
      console.error('      DB_USER=postgres');
      console.error('      DB_PASSWORD=your_password');
      console.error('   3. Or set these as environment variables before running the script');
      console.error('\n   Example:');
      console.error('   DB_HOST=localhost DB_USER=postgres DB_PASSWORD=yourpass node analyze_workflow_compliance.js');
      throw dbError;
    }

    console.log(`✅ Found ${allCalls.rows.length} total conversations\n`);

    if (allCalls.rows.length === 0) {
      console.log('No conversations found in database.');
      return;
    }

    // Analysis results
    const analysis = {
      total: allCalls.rows.length,
      byStatus: {},
      workflowCompliance: {
        compliant: [],
        nonCompliant: [],
        incomplete: []
      },
      stepAnalysis: {
        verification: { completed: 0, missing: 0, issues: [] },
        discovery: { completed: 0, missing: 0, issues: [] },
        qualification_alzheimers: { completed: 0, missing: 0, issues: [] },
        qualification_hospice: { completed: 0, missing: 0, issues: [] },
        qualification_age: { completed: 0, missing: 0, issues: [] },
        qualification_bank: { completed: 0, missing: 0, issues: [] },
        transfer: { completed: 0, missing: 0, issues: [] }
      },
      issues: {
        missingVerification: [],
        missingDiscovery: [],
        missingQualifications: [],
        missingTransfer: [],
        wrongOrder: [],
        duplicateQuestions: [],
        functionCallIssues: []
      }
    };

    // Analyze each conversation
    for (const call of allCalls.rows) {
      const callAnalysis = analyzeCallWorkflow(call);
      
      // Categorize by status
      const status = call.status || 'unknown';
      if (!analysis.byStatus[status]) {
        analysis.byStatus[status] = 0;
      }
      analysis.byStatus[status]++;

      // Categorize workflow compliance
      if (callAnalysis.isCompliant) {
        analysis.workflowCompliance.compliant.push(callAnalysis);
      } else if (callAnalysis.isIncomplete) {
        analysis.workflowCompliance.incomplete.push(callAnalysis);
      } else {
        analysis.workflowCompliance.nonCompliant.push(callAnalysis);
      }

      // Update step analysis
      updateStepAnalysis(analysis.stepAnalysis, callAnalysis);

      // Collect issues
      collectIssues(analysis.issues, callAnalysis);
    }

    // Generate comprehensive report
    generateReport(analysis);

  } catch (error) {
    console.error('❌ Error analyzing conversations:', error);
    throw error;
  }
}

function analyzeCallWorkflow(call) {
  const messages = call.messages || [];
  const analysis = {
    callControlId: call.call_control_id,
    duration: call.duration || 0,
    status: call.status,
    totalMessages: messages.length,
    workflowSteps: {
      verification: { completed: false, found: false, issues: [] },
      discovery: { completed: false, found: false, issues: [] },
      qualification_alzheimers: { completed: false, found: false, issues: [] },
      qualification_hospice: { completed: false, found: false, issues: [] },
      qualification_age: { completed: false, found: false, issues: [] },
      qualification_bank: { completed: false, found: false, issues: [] },
      transfer: { completed: false, found: false, issues: [] }
    },
    qualifications: {
      verified_info: null,
      no_alzheimers: null,
      no_hospice: null,
      age_qualified: null,
      has_bank_account: null
    },
    functionCalls: [],
    stepOrder: [],
    issues: [],
    isCompliant: false,
    isIncomplete: false
  };

  // Extract function calls and analyze messages
  messages.forEach((msg, index) => {
    const text = msg.text || '';
    const speaker = msg.speaker || '';
    const lowerText = text.toLowerCase();

    // Check for function calls in message text
    if (lowerText.includes('update_qualification') || lowerText.includes('set_call_outcome')) {
      extractFunctionCalls(text, analysis.functionCalls, index);
    }

    // Check for workflow steps in AI messages
    if (speaker === 'AI') {
      checkWorkflowSteps(lowerText, analysis, index);
    }
  });

  // Analyze function calls
  analyzeFunctionCalls(analysis);

  // Check workflow order
  checkWorkflowOrder(analysis);

  // Determine compliance
  determineCompliance(analysis);

  return analysis;
}

function extractFunctionCalls(text, functionCalls, messageIndex) {
  // Extract update_qualification calls
  const updateQualRegex = /update_qualification\s*\([^)]*\)/gi;
  let match;
  while ((match = updateQualRegex.exec(text)) !== null) {
    try {
      // Try to extract arguments
      const argsMatch = match[0].match(/\{([^}]+)\}/);
      if (argsMatch) {
        const args = argsMatch[1];
        const call = {
          type: 'update_qualification',
          raw: match[0],
          messageIndex,
          args: {}
        };
        
        // Parse arguments
        if (args.includes('verified_info')) {
          call.args.verified_info = args.includes('verified_info: true') || args.includes('verified_info:true');
        }
        if (args.includes('no_alzheimers')) {
          call.args.no_alzheimers = args.includes('no_alzheimers: true') || args.includes('no_alzheimers:true');
        }
        if (args.includes('no_hospice')) {
          call.args.no_hospice = args.includes('no_hospice: true') || args.includes('no_hospice:true');
        }
        if (args.includes('age_qualified')) {
          call.args.age_qualified = args.includes('age_qualified: true') || args.includes('age_qualified:true');
        }
        if (args.includes('has_bank_account')) {
          call.args.has_bank_account = args.includes('has_bank_account: true') || args.includes('has_bank_account:true');
        }
        
        functionCalls.push(call);
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }

  // Extract set_call_outcome calls
  const setOutcomeRegex = /set_call_outcome\s*\([^)]*\)/gi;
  while ((match = setOutcomeRegex.exec(text)) !== null) {
    try {
      const argsMatch = match[0].match(/\{([^}]+)\}/);
      if (argsMatch) {
        const args = argsMatch[1];
        const call = {
          type: 'set_call_outcome',
          raw: match[0],
          messageIndex,
          outcome: null
        };
        
        if (args.includes('transfer_to_agent')) {
          call.outcome = 'transfer_to_agent';
        } else if (args.includes('disqualified')) {
          call.outcome = 'disqualified';
        } else if (args.includes('user_declined')) {
          call.outcome = 'user_declined';
        } else if (args.includes('user_requested_hangup')) {
          call.outcome = 'user_requested_hangup';
        }
        
        functionCalls.push(call);
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }
}

function checkWorkflowSteps(text, analysis, messageIndex) {
  // Check for verification step
  if (text.includes('last name') && text.includes('address') && 
      (text.includes('right') || text.includes('correct'))) {
    analysis.workflowSteps.verification.found = true;
    analysis.stepOrder.push({ step: WORKFLOW_STEPS.VERIFICATION, index: messageIndex });
  }

  // Check for discovery question (about previous offer)
  if (text.includes('previous offer') || text.includes('wasn\'t claimed') || 
      text.includes('didn\'t move forward') || text.includes('health issue')) {
    analysis.workflowSteps.discovery.found = true;
    analysis.stepOrder.push({ step: WORKFLOW_STEPS.DISCOVERY, index: messageIndex });
  }

  // Check for Alzheimer's question
  if (text.includes('alzheimer') || text.includes('dementia')) {
    analysis.workflowSteps.qualification_alzheimers.found = true;
    analysis.stepOrder.push({ step: WORKFLOW_STEPS.QUALIFICATION_ALZHEIMERS, index: messageIndex });
  }

  // Check for hospice question
  if (text.includes('hospice') || text.includes('nursing home')) {
    analysis.workflowSteps.qualification_hospice.found = true;
    analysis.stepOrder.push({ step: WORKFLOW_STEPS.QUALIFICATION_HOSPICE, index: messageIndex });
  }

  // Check for age question
  if (text.includes('between 50 and 78') || text.includes('50 and 78') || 
      (text.includes('age') && (text.includes('50') || text.includes('78')))) {
    analysis.workflowSteps.qualification_age.found = true;
    analysis.stepOrder.push({ step: WORKFLOW_STEPS.QUALIFICATION_AGE, index: messageIndex });
  }

  // Check for bank account question
  if (text.includes('checking') || text.includes('savings account') || 
      text.includes('bank account')) {
    analysis.workflowSteps.qualification_bank.found = true;
    analysis.stepOrder.push({ step: WORKFLOW_STEPS.QUALIFICATION_BANK, index: messageIndex });
  }

  // Check for transfer mention
  if (text.includes('transfer') || text.includes('connect') || 
      text.includes('licensed agent') || text.includes('get you connected')) {
    analysis.workflowSteps.transfer.found = true;
    analysis.stepOrder.push({ step: WORKFLOW_STEPS.TRANSFER, index: messageIndex });
  }
}

function analyzeFunctionCalls(analysis) {
  // Analyze update_qualification calls
  analysis.functionCalls.forEach(call => {
    if (call.type === 'update_qualification') {
      if (call.args.verified_info !== undefined) {
        analysis.qualifications.verified_info = call.args.verified_info;
        if (call.args.verified_info) {
          analysis.workflowSteps.verification.completed = true;
        }
      }
      if (call.args.no_alzheimers !== undefined) {
        analysis.qualifications.no_alzheimers = call.args.no_alzheimers;
        if (call.args.no_alzheimers === true) {
          analysis.workflowSteps.qualification_alzheimers.completed = true;
        }
      }
      if (call.args.no_hospice !== undefined) {
        analysis.qualifications.no_hospice = call.args.no_hospice;
        if (call.args.no_hospice === true) {
          analysis.workflowSteps.qualification_hospice.completed = true;
        }
      }
      if (call.args.age_qualified !== undefined) {
        analysis.qualifications.age_qualified = call.args.age_qualified;
        if (call.args.age_qualified === true) {
          analysis.workflowSteps.qualification_age.completed = true;
        }
      }
      if (call.args.has_bank_account !== undefined) {
        analysis.qualifications.has_bank_account = call.args.has_bank_account;
        if (call.args.has_bank_account === true) {
          analysis.workflowSteps.qualification_bank.completed = true;
        }
      }
    } else if (call.type === 'set_call_outcome') {
      if (call.outcome === 'transfer_to_agent') {
        analysis.workflowSteps.transfer.completed = true;
      }
    }
  });

  // Check for issues
  // 1. Verification should be called but wasn't
  if (analysis.workflowSteps.verification.found && !analysis.workflowSteps.verification.completed) {
    analysis.issues.push('Verification question asked but update_qualification not called');
    analysis.workflowSteps.verification.issues.push('Function call missing');
  }

  // 2. Discovery question should NOT trigger qualification call
  const discoveryQualCall = analysis.functionCalls.find(call => 
    call.type === 'update_qualification' && 
    call.messageIndex >= analysis.stepOrder.find(s => s.step === WORKFLOW_STEPS.DISCOVERY)?.index - 1 &&
    call.messageIndex <= analysis.stepOrder.find(s => s.step === WORKFLOW_STEPS.DISCOVERY)?.index + 2
  );
  if (discoveryQualCall && analysis.workflowSteps.discovery.found) {
    analysis.issues.push('Discovery question should NOT trigger update_qualification');
    analysis.workflowSteps.discovery.issues.push('Incorrect function call');
  }

  // 3. Qualification questions should have function calls
  const qualSteps = [
    { step: 'qualification_alzheimers', name: 'Alzheimer\'s' },
    { step: 'qualification_hospice', name: 'Hospice' },
    { step: 'qualification_age', name: 'Age' },
    { step: 'qualification_bank', name: 'Bank Account' }
  ];

  qualSteps.forEach(({ step, name }) => {
    if (analysis.workflowSteps[step].found && !analysis.workflowSteps[step].completed) {
      analysis.issues.push(`${name} question asked but update_qualification not called`);
      analysis.workflowSteps[step].issues.push('Function call missing');
    }
  });

  // 4. Transfer should have set_call_outcome
  if (analysis.workflowSteps.transfer.found && !analysis.workflowSteps.transfer.completed) {
    analysis.issues.push('Transfer mentioned but set_call_outcome not called');
    analysis.workflowSteps.transfer.issues.push('Function call missing');
  }
}

function checkWorkflowOrder(analysis) {
  const stepOrder = analysis.stepOrder.map(s => s.step);
  
  // Expected order: verification -> discovery -> qualifications -> transfer
  const expectedOrder = [
    WORKFLOW_STEPS.VERIFICATION,
    WORKFLOW_STEPS.DISCOVERY,
    WORKFLOW_STEPS.QUALIFICATION_ALZHEIMERS,
    WORKFLOW_STEPS.QUALIFICATION_HOSPICE,
    WORKFLOW_STEPS.QUALIFICATION_AGE,
    WORKFLOW_STEPS.QUALIFICATION_BANK,
    WORKFLOW_STEPS.TRANSFER
  ];

  // Check if steps are out of order
  let lastIndex = -1;
  for (const expectedStep of expectedOrder) {
    const currentIndex = stepOrder.indexOf(expectedStep);
    if (currentIndex !== -1) {
      if (currentIndex < lastIndex) {
        analysis.issues.push(`Workflow step out of order: ${expectedStep} appeared before previous steps`);
      }
      lastIndex = currentIndex;
    }
  }

  // Check for duplicate questions
  const stepCounts = {};
  stepOrder.forEach(step => {
    stepCounts[step] = (stepCounts[step] || 0) + 1;
  });
  
  Object.entries(stepCounts).forEach(([step, count]) => {
    if (count > 1) {
      analysis.issues.push(`Duplicate ${step} question (asked ${count} times)`);
    }
  });
}

function determineCompliance(analysis) {
  // A call is compliant if:
  // 1. Verification completed
  // 2. All qualification questions asked and answered (if call progressed that far)
  // 3. Transfer called if user was qualified
  
  const hasVerification = analysis.workflowSteps.verification.completed;
  const hasAllQualifications = 
    analysis.workflowSteps.qualification_alzheimers.completed &&
    analysis.workflowSteps.qualification_hospice.completed &&
    analysis.workflowSteps.qualification_age.completed &&
    analysis.workflowSteps.qualification_bank.completed;
  
  // Check if call was too short to complete workflow (incomplete)
  if (analysis.duration < 30 && analysis.totalMessages < 3) {
    analysis.isIncomplete = true;
    return;
  }

  // Check if call ended early (voicemail, no answer, etc.)
  if (['voicemail', 'no_answer', 'no_response'].includes(analysis.status)) {
    analysis.isIncomplete = true;
    return;
  }

  // For completed calls, check compliance
  if (analysis.status === 'completed' || analysis.status === 'transferred') {
    if (hasVerification && hasAllQualifications) {
      // If all qualifications passed, transfer should be called
      if (analysis.workflowSteps.transfer.found && !analysis.workflowSteps.transfer.completed) {
        // Transfer mentioned but not called
        analysis.isCompliant = false;
      } else if (hasAllQualifications && !analysis.workflowSteps.transfer.found) {
        // All qualifications passed but no transfer attempt
        analysis.isCompliant = false;
        analysis.issues.push('All qualifications passed but transfer not attempted');
      } else {
        analysis.isCompliant = analysis.issues.length === 0;
      }
    } else {
      // Not all qualifications completed
      analysis.isCompliant = false;
    }
  } else {
    // For other statuses, check if workflow was followed up to the point where call ended
    analysis.isCompliant = analysis.issues.length === 0;
  }
}

function updateStepAnalysis(stepAnalysis, callAnalysis) {
  Object.keys(stepAnalysis).forEach(step => {
    const stepData = callAnalysis.workflowSteps[step];
    if (stepData.completed) {
      stepAnalysis[step].completed++;
    } else if (stepData.found) {
      stepAnalysis[step].missing++;
      stepAnalysis[step].issues.push({
        callControlId: callAnalysis.callControlId,
        issues: stepData.issues
      });
    }
  });
}

function collectIssues(issues, callAnalysis) {
  if (!callAnalysis.workflowSteps.verification.completed && callAnalysis.totalMessages > 0) {
    issues.missingVerification.push(callAnalysis.callControlId);
  }
  
  if (!callAnalysis.workflowSteps.discovery.found && callAnalysis.workflowSteps.verification.completed) {
    issues.missingDiscovery.push(callAnalysis.callControlId);
  }

  const missingQuals = [];
  if (!callAnalysis.workflowSteps.qualification_alzheimers.completed) missingQuals.push('alzheimers');
  if (!callAnalysis.workflowSteps.qualification_hospice.completed) missingQuals.push('hospice');
  if (!callAnalysis.workflowSteps.qualification_age.completed) missingQuals.push('age');
  if (!callAnalysis.workflowSteps.qualification_bank.completed) missingQuals.push('bank');
  
  if (missingQuals.length > 0 && callAnalysis.status === 'completed') {
    issues.missingQualifications.push({
      callControlId: callAnalysis.callControlId,
      missing: missingQuals
    });
  }

  if (callAnalysis.workflowSteps.transfer.found && !callAnalysis.workflowSteps.transfer.completed) {
    issues.missingTransfer.push(callAnalysis.callControlId);
  }

  if (callAnalysis.issues.some(i => i.includes('order'))) {
    issues.wrongOrder.push(callAnalysis.callControlId);
  }

  if (callAnalysis.issues.some(i => i.includes('Duplicate'))) {
    issues.duplicateQuestions.push(callAnalysis.callControlId);
  }

  if (callAnalysis.issues.some(i => i.includes('Function call'))) {
    issues.functionCallIssues.push({
      callControlId: callAnalysis.callControlId,
      issues: callAnalysis.issues.filter(i => i.includes('Function call'))
    });
  }
}

function generateReport(analysis) {
  console.log('\n' + '='.repeat(100));
  console.log('📊 COMPREHENSIVE WORKFLOW COMPLIANCE ANALYSIS REPORT');
  console.log('='.repeat(100));
  
  // Summary
  console.log(`\n📈 SUMMARY:`);
  console.log(`   Total conversations: ${analysis.total}`);
  console.log(`   Compliant: ${analysis.workflowCompliance.compliant.length}`);
  console.log(`   Non-compliant: ${analysis.workflowCompliance.nonCompliant.length}`);
  console.log(`   Incomplete: ${analysis.workflowCompliance.incomplete.length}`);
  
  // Status breakdown
  console.log(`\n📊 BY STATUS:`);
  Object.entries(analysis.byStatus).forEach(([status, count]) => {
    console.log(`   ${status}: ${count}`);
  });

  // Step analysis
  console.log(`\n📋 WORKFLOW STEP ANALYSIS:`);
  const stepNames = {
    verification: '1. Verification',
    discovery: '2. Discovery Question',
    qualification_alzheimers: '3a. Qualification: Alzheimer\'s',
    qualification_hospice: '3b. Qualification: Hospice',
    qualification_age: '3c. Qualification: Age',
    qualification_bank: '3d. Qualification: Bank Account',
    transfer: '4. Transfer'
  };

  Object.entries(stepNames).forEach(([step, name]) => {
    const data = analysis.stepAnalysis[step];
    const total = data.completed + data.missing;
    const completionRate = total > 0 ? ((data.completed / total) * 100).toFixed(1) : 0;
    console.log(`   ${name}:`);
    console.log(`      Completed: ${data.completed}`);
    console.log(`      Missing function calls: ${data.missing}`);
    console.log(`      Completion rate: ${completionRate}%`);
  });

  // Issues breakdown
  console.log(`\n⚠️  ISSUES BREAKDOWN:`);
  console.log(`   Missing verification: ${analysis.issues.missingVerification.length}`);
  console.log(`   Missing discovery question: ${analysis.issues.missingDiscovery.length}`);
  console.log(`   Missing qualifications: ${analysis.issues.missingQualifications.length}`);
  console.log(`   Missing transfer calls: ${analysis.issues.missingTransfer.length}`);
  console.log(`   Wrong order: ${analysis.issues.wrongOrder.length}`);
  console.log(`   Duplicate questions: ${analysis.issues.duplicateQuestions.length}`);
  console.log(`   Function call issues: ${analysis.issues.functionCallIssues.length}`);

  // Detailed non-compliant calls
  if (analysis.workflowCompliance.nonCompliant.length > 0) {
    console.log(`\n❌ NON-COMPLIANT CALLS (${analysis.workflowCompliance.nonCompliant.length}):`);
    analysis.workflowCompliance.nonCompliant.slice(0, 20).forEach(call => {
      console.log(`\n   📞 Call: ${call.callControlId}`);
      console.log(`      Status: ${call.status}`);
      console.log(`      Duration: ${call.duration}s`);
      console.log(`      Messages: ${call.totalMessages}`);
      console.log(`      Issues: ${call.issues.length}`);
      call.issues.slice(0, 5).forEach(issue => {
        console.log(`         - ${issue}`);
      });
      
      // Show qualifications
      console.log(`      Qualifications:`);
      Object.entries(call.qualifications).forEach(([key, value]) => {
        const status = value === true ? '✅' : value === false ? '❌' : '❓';
        console.log(`         ${status} ${key}: ${value !== null ? value : 'not set'}`);
      });
    });
    
    if (analysis.workflowCompliance.nonCompliant.length > 20) {
      console.log(`\n   ... and ${analysis.workflowCompliance.nonCompliant.length - 20} more non-compliant calls`);
    }
  }

  // Sample compliant calls
  if (analysis.workflowCompliance.compliant.length > 0) {
    console.log(`\n✅ SAMPLE COMPLIANT CALLS (showing first 5):`);
    analysis.workflowCompliance.compliant.slice(0, 5).forEach(call => {
      console.log(`\n   📞 Call: ${call.callControlId}`);
      console.log(`      Status: ${call.status}`);
      console.log(`      Duration: ${call.duration}s`);
      console.log(`      Messages: ${call.totalMessages}`);
      console.log(`      Qualifications:`);
      Object.entries(call.qualifications).forEach(([key, value]) => {
        const status = value === true ? '✅' : value === false ? '❌' : '❓';
        console.log(`         ${status} ${key}: ${value !== null ? value : 'not set'}`);
      });
    });
  }

  console.log('\n' + '='.repeat(100));
  console.log('✅ Analysis complete');
  console.log('='.repeat(100));
}

// Run analysis
analyzeAllConversations()
  .then(() => {
    console.log('\n✅ Workflow compliance analysis completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Workflow compliance analysis failed:', error);
    process.exit(1);
  });

