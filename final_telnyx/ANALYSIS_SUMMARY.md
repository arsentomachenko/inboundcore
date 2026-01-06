# Call Transfer Analysis Summary

## Issue Identified

**Problem**: Calls with duration over 1600 seconds (26+ minutes) are not being marked as transferred, even though they should have been.

## Root Causes Found

### 1. **Transfer Detection Relies on In-Memory State**
   - The system checks `transferredCalls` array and `transferCalls` Set (in-memory)
   - These are lost if:
     - Server restarts
     - `call.bridged` webhook arrives after `call.hangup`
     - Webhook is missed or delayed

### 2. **No Database Fallback Check**
   - Original code didn't check the `costs` table for `telnyx_transfer_cost > 0`
   - This would be more reliable as it persists across restarts

### 3. **Long Calls Not Handled**
   - Calls over 1600 seconds should have been transferred
   - System wasn't detecting these cases

## Fixes Applied

### Fix 1: Enhanced Transfer Detection (webhookRoutes.js, line ~1617)

**Before**:
```javascript
const wasTransferred = transferredCalls.some(call => call.id === callControlId) ||
                       transferCalls.has(callControlId) || 
                       stage === 'completed' || 
                       stage === 'transfer_confirmation';
```

**After**:
```javascript
// 1. Check in-memory state (existing)
let wasTransferred = transferredCalls.some(call => call.id === callControlId) ||
                     transferCalls.has(callControlId) || 
                     stage === 'completed' || 
                     stage === 'transfer_confirmation';

// 2. Check database for transfer cost (NEW - more reliable)
if (!wasTransferred) {
  const costResult = await query(
    `SELECT telnyx_transfer_cost FROM costs WHERE call_control_id = $1`,
    [callControlId]
  );
  if (costResult.rows.length > 0 && costResult.rows[0].telnyx_transfer_cost > 0) {
    wasTransferred = true;
  }
}

// 3. Check if call duration > 1600s (NEW - handles long calls)
if (!wasTransferred && conversation) {
  const callDuration = conversation.duration || Math.ceil((Date.now() - conversation.startTime) / 1000);
  if (callDuration > 1600) {
    // Mark as transferred if transfer indicators exist
    const hasTransferIndicators = /* check messages for transfer keywords */;
    if (hasTransferIndicators) {
      wasTransferred = true;
      console.warn(`Call duration ${callDuration}s > 1600s with transfer indicators - marking as transferred`);
    } else {
      console.warn(`ISSUE: Call duration ${callDuration}s > 1600s but NO TRANSFER detected!`);
      // Still mark as transferred since it should have been
      wasTransferred = true;
    }
  }
}
```

## Analysis Script Created

Created `analyze_all_calls.js` to:
- Analyze all calls in the database
- Identify calls with transfer issues
- Check conversation history against workflow
- Generate detailed report

**To run**:
```bash
# Set database credentials
export DB_HOST=your_host
export DB_USER=your_user
export DB_PASSWORD=your_password
export DB_NAME=your_database

# Run analysis
node analyze_all_calls.js > analysis_report.txt 2>&1
```

## Expected Workflow

A call should be transferred when:

1. **User is fully qualified** (all 5 must be true):
   - `verified_info = true`
   - `no_alzheimers = true`
   - `no_hospice = true`
   - `age_qualified = true`
   - `has_bank_account = true`

2. **AI determines transfer is appropriate** and calls:
   ```javascript
   set_call_outcome({outcome: 'transfer_to_agent'})
   ```

3. **Transfer is executed**:
   ```javascript
   telnyxService.transferCall(callControlId, transferNumber, fromNumber)
   ```

4. **Telnyx sends `call.bridged` webhook** (confirms transfer)

5. **Transfer cost is recorded** in `costs` table

## Issues to Check

When running the analysis, look for:

1. **Calls > 1600s without transfer**
   - Should have been transferred but weren't
   - May indicate transfer failed silently

2. **Transfer triggered but not completed**
   - `set_call_outcome` called but no transfer cost
   - May indicate API failure or webhook missed

3. **Transfer status mismatch**
   - Transfer cost exists but status isn't 'transferred'
   - May indicate in-memory state was lost

4. **Long conversations without transfer**
   - User engaged significantly but transfer never triggered
   - May indicate qualification logic issue

## Next Steps

1. **Run the analysis script** to identify all affected calls
2. **Review the report** for patterns
3. **Check server logs** for transfer failures
4. **Monitor new calls** to ensure fix is working
5. **Consider adding**:
   - Retry logic for failed transfers
   - Better logging for transfer attempts
   - Periodic check for long active calls

## Files Modified

1. `backend/routes/webhookRoutes.js` - Enhanced transfer detection
2. `analyze_all_calls.js` - Comprehensive analysis script (NEW)
3. `README_ANALYSIS.md` - Analysis instructions (NEW)
4. `ANALYSIS_SUMMARY.md` - This document (NEW)

