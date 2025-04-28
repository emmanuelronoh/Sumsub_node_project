// webhookhandler
import { 
    generate, 
    reGenerate,
    checkUserStatus,
    resetUserProfile,
    getApplicantDocs,
    getVerificationStatus,
    getVerificationHistory
  } from './src/SumsubApiClient.js';
  import './webhookHandler.js'; // This will start your webhook server
  
  // Example usage with all available functions
  const userId = 'user-' + Math.random().toString(36).substring(2, 8);
  const levelName = 'kyc_verification'; // Use your configured level name
  
  (async () => {
    try {
      console.log('=== Starting Sumsub Integration Demo ===');
      
      // 1. Generate initial verification link
      console.log('\n1. Generating initial verification link...');
      const url = await generate(userId, levelName);
      console.log("Generated Web SDK Link:", url);
  
      // 2. Check user status (simulating admin check)
      console.log('\n2. Checking user status...');
      const status = await checkUserStatus(userId);
      console.log("User Status:", status.reviewStatus || 'pending');
      
      // 3. Get applicant documents (admin function)
      console.log('\n3. Fetching required documents...');
      const docs = await getApplicantDocs(userId);
      console.log("Required Documents Status:", docs);
      
      // 4. Regenerate link (simulating user needing new session)
      console.log('\n4. Regenerating verification link...');
      const reGeneratedUrl = await reGenerate(userId, levelName);
      console.log("Re-generated Web SDK Link:", reGeneratedUrl);
      
      // 5. Get verification status (cached version)
      console.log('\n5. Getting verification status...');
      const verification = await getVerificationStatus(userId);
      console.log("Verification Status:", verification.status);
      
      // 6. Get full verification history (admin function)
      console.log('\n6. Fetching verification history...');
      const history = await getVerificationHistory(userId);
      console.log("Verification History:", history);
      
      
      console.log('\n=== Demo Complete ===');
      console.log('Note: Webhook events will be processed separately');
      console.log(`Test User ID: ${userId}`);
      
    } catch (error) {
      console.error("\n!!! Error occurred:", {
        message: error.message,
        stack: error.stack,
        response: error.response || 'No additional error details'
      });
      process.exit(1);
    }
  })();