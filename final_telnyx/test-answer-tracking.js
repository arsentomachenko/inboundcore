#!/usr/bin/env node

/**
 * Test script for answer tracking functionality
 */

const userModel = require('./backend/models/userModel');

async function testAnswerTracking() {
  console.log('🧪 Testing Answer Tracking Functionality\n');
  
  // Test 1: Get all answered users
  console.log('📊 Test 1: Get Answered Users (Real People)');
  const answeredUsers = await userModel.getAnsweredUsers();
  console.log(`   Found ${answeredUsers.length} users who answered`);
  answeredUsers.slice(0, 3).forEach(user => {
    console.log(`   - ${user.firstname} ${user.lastname}: ${user.phone}`);
    console.log(`     Answered at: ${user.answeredAt}`);
    console.log(`     Stage: ${user.conversationStage}\n`);
  });
  
  // Test 2: Get voicemail users
  console.log('📞 Test 2: Get Voicemail Users');
  const voicemailUsers = await userModel.getUsersByAnswerType('voicemail');
  console.log(`   Found ${voicemailUsers.length} users who went to voicemail`);
  voicemailUsers.slice(0, 3).forEach(user => {
    console.log(`   - ${user.firstname} ${user.lastname}: ${user.phone}`);
  });
  
  // Test 3: Get statistics
  console.log('\n📈 Test 3: Answer Statistics');
  const allUsers = await userModel.getAllUsers();
  
  const stats = {
    total: allUsers.length,
    answered: allUsers.filter(u => u.answered === true).length,
    voicemail: allUsers.filter(u => u.answerType === 'voicemail').length,
    no_answer: allUsers.filter(u => u.answerType === 'no_answer').length,
    not_found: allUsers.filter(u => u.answerType === 'not_found').length,
    pending: allUsers.filter(u => u.answerType === null).length,
  };
  
  console.log(`   Total Users: ${stats.total}`);
  console.log(`   ✅ Answered (Real Person): ${stats.answered} (${((stats.answered/stats.total)*100).toFixed(1)}%)`);
  console.log(`   📞 Voicemail: ${stats.voicemail} (${((stats.voicemail/stats.total)*100).toFixed(1)}%)`);
  console.log(`   ❌ No Answer: ${stats.no_answer} (${((stats.no_answer/stats.total)*100).toFixed(1)}%)`);
  console.log(`   🚫 Not Found: ${stats.not_found} (${((stats.not_found/stats.total)*100).toFixed(1)}%)`);
  console.log(`   ⏳ Pending: ${stats.pending} (${((stats.pending/stats.total)*100).toFixed(1)}%)`);
  
  // Test 4: Test marking a user as answered
  console.log('\n✏️  Test 4: Mark User as Answered');
  const testUser = allUsers.find(u => u.phone.includes('2622709138')); // cele felski from logs
  if (testUser) {
    console.log(`   User: ${testUser.firstname} ${testUser.lastname}`);
    console.log(`   Before: answered=${testUser.answered}, answerType=${testUser.answerType}`);
    
    // This would normally happen automatically during a call
    // await userModel.markUserAnswered(testUser.phone, 'answered', 'reason_not_forward');
    console.log(`   (Would mark as answered with stage: reason_not_forward)`);
  }
  
  console.log('\n✅ Answer tracking tests completed!\n');
}

// Run tests
testAnswerTracking().catch(console.error);

