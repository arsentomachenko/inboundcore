# Call Analysis Instructions

## Running the Analysis Script

The analysis script requires database access. To run it:

1. **Set up database credentials** (if not already in environment):
   ```bash
   export DB_HOST=your_db_host
   export DB_PORT=5432
   export DB_NAME=your_db_name
   export DB_USER=your_db_user
   export DB_PASSWORD=your_db_password
   ```

2. **Run the analysis**:
   ```bash
   node analyze_all_calls.js > analysis_report.txt 2>&1
   ```

3. **View the report**:
   ```bash
   cat analysis_report.txt
   ```

## What the Analysis Checks

The script analyzes all calls in the database and identifies:

1. **Long Calls Without Transfer**: Calls over 1600 seconds (26+ minutes) that weren't transferred
2. **Should Have Transferred**: Calls where transfer was triggered but didn't complete, or long conversations that should have transferred
3. **Transfer Status Mismatch**: Calls where transfer cost exists but status isn't 'transferred', or vice versa
4. **Incomplete Conversations**: Long calls with no user messages
5. **Anomalies**: Other unusual patterns (extremely long calls, calls with duration but no messages, etc.)

## Workflow Understanding

Based on the code analysis, a call should be transferred when:

1. **User is fully qualified** (all 5 qualifications):
   - `verified_info = true`
   - `no_alzheimers = true`
   - `no_hospice = true`
   - `age_qualified = true`
   - `has_bank_account = true`

2. **AI calls `set_call_outcome`** with `outcome='transfer_to_agent'`

3. **User agrees to transfer**

4. **Transfer is executed** via `telnyxService.transferCall()`

5. **`call.bridged` webhook** is received (confirms transfer completed)

## Common Issues Found

### Issue 1: Transfer Triggered But Not Completed
- **Symptom**: `set_call_outcome` called with `transfer_to_agent` but no transfer cost
- **Possible Causes**:
  - Transfer API call failed silently
  - `call.bridged` webhook never arrived
  - Server restarted before transfer completed

### Issue 2: Long Calls Without Transfer
- **Symptom**: Call duration > 1600 seconds but no transfer
- **Possible Causes**:
  - Transfer was never triggered (user not fully qualified)
  - Transfer failed but call continued
  - Transfer was triggered but not properly tracked

### Issue 3: Transfer Status Mismatch
- **Symptom**: Transfer cost exists but status isn't 'transferred'
- **Possible Causes**:
  - In-memory state lost (server restart)
  - `call.bridged` webhook arrived after hangup
  - Database update failed

## Fixes Applied

The code has been updated to:

1. **Check database for transfer cost** (more reliable than in-memory state)
2. **Detect long calls** (>1600s) and mark as transferred if appropriate
3. **Log warnings** when transfers should have happened but didn't

See `backend/routes/webhookRoutes.js` around line 1617 for the updated transfer detection logic.

