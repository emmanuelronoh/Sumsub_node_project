import { generate, reGenerate } from './src/SumsubApiClient.js';

// Example usage
const userId = 'example-user-id';

(async () => {
    try {
        const url = await generate(userId);
        console.log("Generated Web SDK Link:", url);

        // To regenerate the link and reset user profile
        const reGeneratedUrl = await reGenerate(userId);
        console.log("Re-generated Web SDK Link:", reGeneratedUrl);
    } catch (error) {
        console.error("Error:", error);
    }
})();




