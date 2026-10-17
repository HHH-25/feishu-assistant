// Test imports must see the mock default even when a developer has a local real-mode .env.
// Individual real-mode tests can override these values before importing the module under test.
process.env.CLIENT_MODE = 'mock';
process.env.MODEL_MODE = 'mock';
