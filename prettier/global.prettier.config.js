/** @type {import("prettier").Config} */
module.exports = {
  semi: true,
  singleQuote: false,
  printWidth: 100,
  tabWidth: 2,
  trailingComma: "all",

  overrides: [
    {
      files: "*.md",
      options: {
        proseWrap: "always",
        printWidth: 80,
      },
    },
    {
      files: "*.mdx",
      options: {
        proseWrap: "always",
      },
    },

    {
      files: ["*.yml", "*.yaml"],
      options: {
        tabWidth: 2,
      },
    },
    {
      files: "*.json",
      options: {
        printWidth: 80,
      },
    },
  ],
};
