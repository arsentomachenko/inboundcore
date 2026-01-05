/**
 * Check Call Recordings
 * Script to check if recordings are being created and stored
 */

const { query } = require('../config/database');

async function checkRecordings() {
  try {
    console.log('🔍 Checking call recordings...\n');
    
    // Check if table exists and get count
    const countResult = await query('SELECT COUNT(*) as count FROM call_recordings');
    const totalRecordings = parseInt(countResult.rows[0].count);
    
    console.log(`📊 Total recordings in database: ${totalRecordings}\n`);
    
    if (totalRecordings === 0) {
      console.log('⚠️  No recordings found in database.');
      console.log('   This could mean:');
      console.log('   1. Recording is not starting successfully');
      console.log('   2. Recording webhooks are not being received');
      console.log('   3. Calls haven\'t completed yet (recordings come after call ends)');
    } else {
      // Show recent recordings
      console.log('📋 Recent recordings:\n');
      const recentResult = await query(`
        SELECT 
          call_control_id,
          status,
          recording_url,
          duration_seconds,
          recording_started_at,
          error_message,
          created_at
        FROM call_recordings
        ORDER BY created_at DESC
        LIMIT 10
      `);
      
      if (recentResult.rows.length > 0) {
        recentResult.rows.forEach((rec, index) => {
          console.log(`${index + 1}. Call Control ID: ${rec.call_control_id}`);
          console.log(`   Status: ${rec.status}`);
          console.log(`   Duration: ${rec.duration_seconds || 'N/A'}s`);
          console.log(`   URL: ${rec.recording_url ? '✅ Available' : '❌ Missing'}`);
          if (rec.error_message) {
            console.log(`   Error: ${rec.error_message}`);
          }
          console.log(`   Created: ${rec.created_at}`);
          console.log('');
        });
      }
    }
    
    // Check conversations without recordings
    console.log('\n📞 Checking conversations without recordings:\n');
    const conversationsWithoutRecording = await query(`
      SELECT 
        c.call_control_id,
        c.status,
        c.duration,
        c.created_at
      FROM conversations c
      LEFT JOIN call_recordings r ON c.call_control_id = r.call_control_id
      WHERE r.call_control_id IS NULL
      ORDER BY c.created_at DESC
      LIMIT 10
    `);
    
    if (conversationsWithoutRecording.rows.length > 0) {
      console.log(`Found ${conversationsWithoutRecording.rows.length} conversations without recordings:\n`);
      conversationsWithoutRecording.rows.forEach((conv, index) => {
        console.log(`${index + 1}. ${conv.call_control_id} - Status: ${conv.status} - Duration: ${conv.duration}s`);
      });
    } else {
      console.log('✅ All recent conversations have recordings (or table is empty)');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error checking recordings:', error);
    process.exit(1);
  }
}

checkRecordings();


