// Paste this in your browser console (F12) to debug why costs aren't showing

console.log('🔍 Starting Cost Display Debug...\n');

// Test 1: Check API
fetch('http://localhost:3000/api/agent/stats')
  .then(r => r.json())
  .then(data => {
    console.log('✅ API Response:', data);
    console.log('💰 Costs from API:', data.data.costs);
    console.log('   Total:', data.data.costs.totalCost);
    console.log('   Telnyx:', data.data.costs.telnyxCost);
    console.log('   OpenAI:', data.data.costs.openaiCost);
    
    // Test 2: Check if panel exists in DOM
    const panels = document.querySelectorAll('[class*="MuiPaper"]');
    console.log('\n📦 Found', panels.length, 'Paper components');
    
    // Test 3: Check for cost text
    const bodyText = document.body.innerText;
    const hasCostAnalysis = bodyText.includes('Cost Analysis');
    const hasTotalCost = bodyText.includes('Total Cost');
    
    console.log('\n🔍 Text Search:');
    console.log('   Has "Cost Analysis"?', hasCostAnalysis);
    console.log('   Has "Total Cost"?', hasTotalCost);
    
    if (hasCostAnalysis) {
      console.log('   ✅ Panel exists in DOM');
      
      // Find all text that looks like costs
      const costRegex = /\$\d+\.\d+/g;
      const costMatches = bodyText.match(costRegex);
      console.log('   Found cost values:', costMatches);
      
      if (costMatches && costMatches.every(c => c === '$0.00')) {
        console.error('\n❌ PROBLEM: Panel shows $0.00 even though API has costs!');
        console.log('\n🔧 SOLUTION: Try one of these:');
        console.log('   1. Hard refresh: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)');
        console.log('   2. Clear cache and reload');
        console.log('   3. Close and reopen browser');
        console.log('   4. Check React DevTools for state');
      }
    } else {
      console.error('\n❌ PROBLEM: Cost Analysis panel not found in page!');
      console.log('\n🔧 Check:');
      console.log('   1. Are you on the AI Agent page?');
      console.log('   2. Is frontend running? (npm run start)');
      console.log('   3. Did you hard refresh?');
    }
    
    // Test 4: Check React state (if DevTools available)
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
      console.log('\n✅ React DevTools detected');
      console.log('   Open React DevTools → Find AgentControl component → Check costStats state');
    }
  })
  .catch(err => {
    console.error('❌ API Error:', err);
    console.log('   Is backend running on port 3000?');
  });

// Test 5: Force fetch with visual feedback
console.log('\n⏰ Will auto-check again in 5 seconds...');
setTimeout(() => {
  fetch('http://localhost:3000/api/agent/stats')
    .then(r => r.json())
    .then(data => {
      console.log('\n🔄 Refresh check:');
      console.log('   API still shows:', data.data.costs.totalCost);
      console.log('   Page shows:', document.body.innerText.match(/Total Cost.*?\$(\d+\.\d+)/)?.[1] || 'NOT FOUND');
    });
}, 5000);

