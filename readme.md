## Project: Sumsub Integration

This project provides functions to interact with the Sumsub verification platform using Node.js. 

**Features:**

* Generates a Web SDK link for user verification.
* Resets a user's verification profile (allowing them to re-verify).

**Requirements:**

* Node.js and npm (or yarn) package manager.
* A Sumsub developer account and API credentials.

**Installation:**

1. Clone this repository.
2. Install dependencies:

```bash
npm install
```

**Configuration:**

1. Create a `.env` file in the project root directory.
2. Add the following environment variables to the `.env` file:

* `SUMSUB_APP_TOKEN`: Your Sumsub application access token.
* `SUMSUB_SECRET_KEY`: Your Sumsub application secret key.

**Usage:**
To use the client, you can run the index.js file:

```bash
npm start
```

**Usage:**

This project exports two functions:

* `generate(userId)`: Generates a new Web SDK link for a user with the specified `userId`.
* `reGenerate(userId)`: Resets the user's verification profile and then generates a new Web SDK link.

**Example:**

```javascript
import { generate, reGenerate } from './sumsub';

const userId = '12345'; // Replace with your user ID

(async () => {
  try {
    const url = await generate(userId);
    console.log('Web SDK Link:', url);
  } catch (error) {
    console.error('Error generating Web SDK Link:', error);
  }

  // Alternatively, to reset and regenerate the link:
  try {
    const url = await reGenerate(userId);
    console.log('Web SDK Link:', url);
  } catch (error) {
    console.error('Error regenerating Web SDK Link:', error);
  }
})();
```

**Notes:**

* This is a basic example. You may need to modify it based on your specific needs.
* Refer to the Sumsub API documentation for more details on available functionality: [https://docs.sumsub.com/reference/about-sumsub-api](https://docs.sumsub.com/reference/about-sumsub-api)
