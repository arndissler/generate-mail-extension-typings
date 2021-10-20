import { existsSync } from "fs";
import { join, sep, resolve } from "path";
import { opendir, readFile, writeFile } from "fs/promises";
import meow from "meow";

interface SchemaPartFunctionParameter {
  readonly name: string;
  readonly optional: boolean;
  readonly type: string;
  readonly description?: string;
}

interface SchemaPartFunction {
  readonly name: string;
  readonly async: "callback" | "responseCallback" | boolean;
  readonly description: string;
  readonly parameters: SchemaPartFunctionParameter[];
}

interface SchemaPartType {
  readonly id: string;
  readonly async?: string;
  readonly description?: string;
  readonly type?: string;
  readonly properties?: {
    [key: string]: SchemaPartType;
  };
  readonly choices?: SchemaPartType[];
  readonly enum?: SchemaPartType[];
  readonly optional?: boolean;
}

interface SchemaPart {
  readonly namespace: string;
  readonly description?: string;
  readonly functions: SchemaPartFunction[];
  readonly types: SchemaPartType[];
}

const logger = {
  info: (...args: any) => console.info(...args),
  log: (...args: any) => console.log(...args),
  warn: (...args: any) => console.warn(...args),
  error: (...args: any) => console.error(...args),
};

const cli = meow(
  `Required Options

  --schema-directory
    The path to Thunderbird's .json schema files below the "source" directory,
    e.g. path/to/thunderbird/source/comm/mail/components/extensions/schemas
  --browser-schema-directory
    The path to the browser .json schmea files,
    e.g. path/to/thunderbird/source/toolkit/components/extensions/schemas
  --output-directory ./out
    The output folder where the index.d.ts file should be written to
`,
  {
    importMeta: import.meta,
    flags: {
      schemaDirectory: {
        type: "string",
        isRequired: true,
      },
      browserSchemaDirectory: {
        type: "string",
        isRequired: true,
      },
      outputDirectory: {
        type: "string",
        isRequired: true,
      },
    },
  }
);

const readSchemaFileNames = async (
  directoryName: string
): Promise<string[]> => {
  logger.log(`reading schema directory: '${directoryName}'`);
  if (!existsSync(directoryName)) {
    logger.warn(`Directory not found: '${directoryName}'`);
    return [];
  }

  let result = [];
  const directory = await opendir(directoryName);
  for await (const entry of directory) {
    if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".json")) {
      logger.info(`adding: ${entry.name}`);
      result.push(join(directoryName, sep, entry.name));
    }
  }

  return result;
};

const readSchemaInformationFromFile = async (
  filename: string
): Promise<SchemaPart[]> => {
  logger.log(`read schema file: ${filename}`);
  const content = await readFile(filename, "utf-8");
  const lines = content.split("\n");
  const uncommentedLines = lines.filter(
    (line) => !line.trim().startsWith("//")
  );
  let jsonFileContents = uncommentedLines.join("\n");
  if (jsonFileContents.startsWith("/* ")) {
    jsonFileContents = jsonFileContents.substr(
      jsonFileContents.indexOf("*/") + 2
    );
  }

  const schemaParts: SchemaPart[] = JSON.parse(jsonFileContents);
  if (!Array.isArray(schemaParts)) {
    throw new Error(`Error reading schema file: ${filename}`);
  }

  schemaParts.forEach((schemaPart) =>
    logger.log(`...processing namespace: ${schemaPart.namespace}`)
  );

  return schemaParts;
};

const mergeNamespaceFunctions = (
  functions: SchemaPartFunction[],
  existingSchemaPart: SchemaPart
) => {
  return functions
    .concat(existingSchemaPart.functions)
    .filter(
      (schemaPart, index, result) => result.indexOf(schemaPart) === index
    );
};

const mergeNamespaceTypes = (
  types: SchemaPartType[],
  existingSchemaPart: SchemaPart
) => {
  return types
    .concat(existingSchemaPart.types)
    .filter((schemaPart, index, result) => {
      if (!schemaPart.id) {
        // always keep parts with no name
        return 0;
      }

      return result.findIndex((item) => item.id === schemaPart.id) === index;
    });
};

const mergeSchema = (schemaParts: SchemaPart[]): Map<string, SchemaPart> => {
  const namespaces = new Map<string, SchemaPart>();
  schemaParts.forEach((schemaPart) => {
    const { namespace, functions = [], types = [] } = schemaPart;
    if (!namespaces.has(namespace)) {
      // initialize the namespace object
      namespaces.set(namespace, { ...schemaPart, functions, types });
    } else {
      // update existing parts
      const existingSchemaPart = namespaces.get(namespace)!;
      const mergedSchemaPart = {
        namespace,
        functions: mergeNamespaceFunctions(functions, existingSchemaPart),
        types: mergeNamespaceTypes(types, existingSchemaPart),
      };

      namespaces.set(namespace, mergedSchemaPart);
    }
  });

  return namespaces;
};

const postProcessSchemaFunctions = (schemaFunctions: SchemaPartFunction[]) => {
  return schemaFunctions.filter((item) => item.name !== "delete");
};

const postProcessNamespaces = (
  namespaces: Map<string, SchemaPart>
): Map<string, SchemaPart> => {
  const result = new Map<string, SchemaPart>();
  namespaces.forEach((namespaceSchema, namespace) => {
    result.set(namespace, {
      ...namespaceSchema,
      functions: postProcessSchemaFunctions(namespaceSchema.functions),
    });
  });
  return result;
};

const readSchemaFiles = async (filenames: string[]): Promise<SchemaPart[]> => {
  let result: SchemaPart[] = [];
  for (const filename of filenames) {
    const schemaParts = await readSchemaInformationFromFile(filename);
    result = result.concat(schemaParts);
  }

  return result;
};

const generateDescription = (
  chunk: { description?: string },
  indention: number = 0
): string => {
  if (chunk.description) {
    return `${Array(indention).join("  ")}  /**\n ${Array(indention + 1).join(
      "  "
    )}* ${chunk.description}
  */\n`;
  }

  return "";
};

const generateFunctionParams = (parameters: SchemaPartFunctionParameter[]) => {
  const result: string[] = [];
  parameters.forEach((param) => {
    result.push(
      `${generateDescription(param)}\n${param.name}${
        param.optional ? "?" : ""
      }: ${getType(param)}`.trim()
    );
  });
  return result.join(", ");
};

const generateFunctionTypings = (
  currentNamespace: string,
  namespaces: Map<string, SchemaPart>
): string => {
  let result = "";
  const schema = namespaces.get(currentNamespace);
  if (!schema || schema.functions.length === 0) {
    return result;
  }

  schema.functions.forEach((schemaPart) => {
    const findReturnType = (func: SchemaPartFunction) => {
      const parameters = func.parameters.filter(
        (param) =>
          param.name !== "callback" && param.name !== "responseCallback"
      );

      if (typeof func.async === "string") {
        const asyncReturnType = func.parameters.find(
          (param) => param.name === "callback"
        );
        if (func.async === "callback" && asyncReturnType !== undefined) {
          return { returnType: getType(asyncReturnType), parameters };
        } else if (func.async === "responseCallback") {
          // check if we have a responseCallback type,
          // then we have to patch the param list as well
          return {
            returnType: "Promise<any>",
            parameters: parameters.filter(
              (param) => param.name === "responseCallback"
            ),
          };
        }
        return { returnType: "ERR", parameters: [] };
      }

      return {
        returnType: func.async === true ? "Promise<void>" : "void",
        parameters,
      };
    };

    const { returnType, parameters } = findReturnType(schemaPart);

    if (returnType === "ERR") {
      const error = `Unknown async type, namespace ${currentNamespace}, function '${schemaPart.name}': '${schemaPart.async}'`;
      // throw new Error(

      // );
      logger.error(error);
    }
    result += generateDescription(schemaPart);

    // check if we have optional parameters BEFORE defining required parameters
    // if so, add additional function signatures
    const firstOptionalParameter = parameters.findIndex(
      (param) => param.optional
    );
    const firstRequiredParameter = parameters.findIndex(
      (param) => !param.optional
    );

    if (
      firstOptionalParameter >= 0 &&
      firstOptionalParameter < firstRequiredParameter
    ) {
      const requireAllParams = (params: SchemaPartFunctionParameter[]) =>
        params.map((parameter) => ({ ...parameter, optional: false }));
      const leadingOptionalParameters = parameters.slice(
        0,
        firstRequiredParameter
      );

      let overrides = "";
      leadingOptionalParameters.forEach((_, index) => {
        overrides += `  function ${schemaPart.name}(${generateFunctionParams(
          requireAllParams(parameters.slice(index + 1))
        )}): ${returnType};`;
        overrides += `\n`;
        result += overrides;
      });
      result += `  function ${schemaPart.name}(${generateFunctionParams(
        requireAllParams(parameters)
      )}): ${returnType};`;
      result += `\n`;
    } else {
      result += `  function ${schemaPart.name}(${generateFunctionParams(
        parameters
      )}): ${returnType};`;
      result += `\n`;
    }
  });
  return result;
};

const getType = (property: {
  $ref?: string;
  type?: string;
  enum?: any;
  items?: { type: string } | { $ref: string };
  choices?: SchemaPartType[];
  properties?: {
    [key: string]: SchemaPartType;
  };
}): string => {
  if (property.$ref) {
    return property.$ref;
  }

  if (property.type === "integer") {
    return "number";
  }

  if (property.type === "number") {
    return "number";
  }

  if (property.type === "string") {
    if (property.enum) {
      if (Array.isArray(property.enum)) {
        return Array.from(property.enum)
          .map((item) => `'${item}'`)
          .join(`\n | `)
          .trim();
      }
      return "enum";
    }

    return "string";
  }

  if (property.type === "array") {
    if (!property.items) {
      throw new Error("Cannot create array typing");
    }

    const items = property.items as any;
    if (items["type"]) {
      return `${getType(items)}[]`;
    } else {
      const refName = (items["$ref"] || "") as string;
      if (refName.indexOf(".") >= 0) {
        return `void /* ${refName} */`;
      }
      return `${refName}[]`;
    }
  }

  if (property.type === "boolean") {
    return "boolean";
  }

  if (property.choices && Array.isArray(property.choices)) {
    const { choices = [] } = property;
    return choices.map((choice) => getType(choice)).join(" | ");
  }

  if (property.type === "object") {
    if (property.properties) {
      const entries = Object.entries(property.properties);
      let result = "";
      entries.forEach(([name, prop]) => {
        result += generatePropertyTypings({
          name,
          isInterfaceProperty: true,
          ...prop,
        });
      });
      return `{
  ${result}
  }`;
    }
    return `/* "unknown" ${property.properties} */ object`;
  }

  return "void";
};

const generatePropertyTypings = (property: {
  name: string;
  $ref?: string;
  type?: string;
  enum?: any;
  description?: string;
  choices?: SchemaPartType[];
  properties?: {
    [key: string]: SchemaPartType;
  };
  isInterfaceProperty?: boolean;
  unsupported?: boolean;
  optional?: boolean;
}): string => {
  let result = "";
  if (property.unsupported) {
    return result;
  }

  if (property.choices && !property.isInterfaceProperty) {
    result += generateDescription(property);
    result += `  type ${property.name} = ${getType(property)};\n`;
  } else {
    result += generateDescription(property, 1);
    result += `    ${property.name}${property.optional ? "?" : ""}: ${getType(
      property
    )};\n`;
  }

  return result;
};

const generateTypeTypings = (
  currentNamespace: string,
  namespaces: Map<string, SchemaPart>
): string => {
  let result = "";
  const schema = namespaces.get(currentNamespace);
  if (!schema || schema.types.length === 0) {
    return result;
  }

  schema.types.forEach((schemaPart) => {
    result += generateDescription(schemaPart);

    if (schemaPart.type === "object") {
      result += `  interface ${schemaPart.id} {\n`;
      if (schemaPart.properties) {
        const entries = Object.entries(schemaPart.properties);
        entries.forEach(([name, prop]) => {
          result += generatePropertyTypings({
            name,
            isInterfaceProperty: true,
            ...prop,
          });
        });
      }
      result += `  }\n`;
    } else if (schemaPart.type === "string") {
      result += generateDescription(schemaPart);
      result += `  type ${schemaPart.id} = string;`;
    } else if (schemaPart.type === "url") {
      result += generateDescription(schemaPart);
      result += `  type ${schemaPart.id} = string;`;
    } else if (schemaPart.id) {
      result += `  /* skipped: ${schemaPart.id}: ${schemaPart.type} */\n`;
      result += `  type ${schemaPart.id} = ${getType({ ...schemaPart })};`;
    } else {
      result += `  /* skipped: .extend ${(schemaPart as any).$extend}: ${
        schemaPart.type
      } */\n`;
    }
    result += `\n`;
  });
  return result;
};

const generateTypingsFile = async (
  outputDirectory: string,
  namespaces: Map<string, SchemaPart>
) => {
  let data = "";
  namespaces.forEach((schema, namespace) => {
    data += generateDescription(schema);
    data += `declare namespace browser.${namespace} {\n`;

    data += generateTypeTypings(namespace, namespaces);
    data += generateFunctionTypings(namespace, namespaces);

    data += `}\n\n`;
  });

  await writeFile(resolve(join(outputDirectory, sep, "index.d.ts")), data, {
    flag: "w+",
  });
};

const generateTypings = async ({
  schemaDirectory,
  browserSchemaDirectory,
  outputDirectory,
}: {
  readonly schemaDirectory: string;
  readonly browserSchemaDirectory: string;
  readonly outputDirectory: string;
}) => {
  const filenames = [
    ...(await readSchemaFileNames(schemaDirectory)),
    ...(await readSchemaFileNames(browserSchemaDirectory)),
  ];

  const schemaParts = await readSchemaFiles(filenames);
  const namespaces = postProcessNamespaces(mergeSchema(schemaParts));

  await generateTypingsFile(outputDirectory, namespaces);
};

generateTypings(cli.flags);
