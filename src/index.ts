import { existsSync } from "fs";
import { join, sep, resolve } from "path";
import { opendir, readFile, writeFile } from "fs/promises";
import meow from "meow";

const DEBUG = false;

interface SchemaPartFunctionParameter {
  readonly name: string;
  readonly optional: boolean;
  readonly type: string;
  readonly description?: string;
  readonly parameters?: SchemaPartType[];
}

interface SchemaPartFunction {
  readonly name: string;
  readonly async: "callback" | "responseCallback" | boolean | string;
  readonly description: string;
  readonly parameters: SchemaPartFunctionParameter[];
  readonly returns: SchemaPartFunctionParameter | null;
}

interface SchemaPartType {
  readonly id: string;
  readonly async?: string;
  readonly description?: string;
  readonly type?: string;
  readonly properties?: {
    [key: string]: SchemaPartType;
  };
  readonly functions: SchemaPartFunction[];
  readonly events: SchemaPartFunction[];
  readonly choices?: SchemaPartType[];
  readonly enum?: SchemaPartType[];
  readonly optional?: boolean;
  readonly name?: string;
  readonly value?: string;
  readonly $ref?: string;
}

interface SchemaPart {
  readonly namespace: string;
  readonly description?: string;
  readonly functions: SchemaPartType["functions"];
  readonly events: SchemaPartType["events"];
  readonly types: SchemaPartType[];
  readonly properties: { [key: string]: SchemaPartType };
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
  --ignored-namespaces test
    namespaces that should be ignored, comma separated list (e.g. test,runtime)
    WARNING: may lead to a corrupt type definition file
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
      ignoredNamespaces: {
        type: "string",
        isRequired: false,
        default: "",
      },
    },
  }
);

const debug = (msg: string) => (DEBUG ? msg : "");

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

const mergeNamespaceEvents = (
  events: SchemaPartFunction[],
  existingSchemaPart: SchemaPart
) => {
  const result = events.concat(
    existingSchemaPart.events.filter(
      (schemaPart) =>
        !events.some(
          (item) =>
            item.async === schemaPart.async && item.name === schemaPart.name
        )
    )
  );

  return result;
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

const mergeNameSpaceProperties = (
  properties: SchemaPart["properties"],
  existingSchemaPart: SchemaPart
) => {
  return properties;
};

const mergeSchema = (schemaParts: SchemaPart[]): Map<string, SchemaPart> => {
  const namespaces = new Map<string, SchemaPart>();
  schemaParts.forEach((schemaPart) => {
    const {
      namespace,
      functions = [],
      types = [],
      events = [],
      properties,
    } = schemaPart;
    if (!namespaces.has(namespace)) {
      // initialize the namespace object
      namespaces.set(namespace, {
        ...schemaPart,
        functions,
        types,
        events,
      });
    } else {
      // update existing parts
      const existingSchemaPart = namespaces.get(namespace)!;
      const mergedSchemaPart = {
        namespace,
        functions: mergeNamespaceFunctions(functions, existingSchemaPart),
        types: mergeNamespaceTypes(types, existingSchemaPart),
        properties: mergeNameSpaceProperties(properties, existingSchemaPart),
        events: mergeNamespaceEvents(events, existingSchemaPart),
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

const findNamespaceFortype = (
  $ref: string,
  namespaces: Map<string, SchemaPart> | undefined
): string[] => {
  let result: string[] = [];
  namespaces?.forEach(({ types }, namespace) => {
    if (types.find((item) => item.id === $ref)) {
      console.log(`FOUND! :: '${namespace}.${$ref}`);
      result.push(namespace);
    }
  });

  return result;
};

const generateDescription = (
  chunk: { description?: string },
  indention: number = 0
): string => {
  const { description } = chunk;
  if (description) {
    return `${Array(indention).join("  ")}  /**\n ${Array(indention + 1).join(
      "  "
    )}* ${description
      .replace(/<\/?code>/g, "`")
      .replace(/<\/?b>/g, "**")
      .replace(/<\/?em>/g, "*")
      .replace(/<\/?strong>/g, "**")}
  */\n`;
  }

  return "";
};

const createFunctionDefinition = (
  schemaPart: SchemaPartFunction,
  currentNamespace: string,
  options?: {
    omitFunctionKeyword?: boolean;
    omitFunctionName?: boolean;
    omitDescription?: boolean;
    inlineFunction?: boolean;
    overrideDelimiter?: string;
    wrapInBrackets?: boolean;
  },
  namespaces?: Map<string, SchemaPart>
) => {
  const {
    omitFunctionKeyword = false,
    omitFunctionName = false,
    omitDescription = false,
    inlineFunction = false,
    overrideDelimiter = ";",
    wrapInBrackets = false,
  } = options || {};
  let result = "";
  const findReturnType = (func: SchemaPartFunction) => {
    const parameters = (schemaPart.parameters || []).filter(
      (param) => param.name !== "callback" && param.name !== "responseCallback"
    );
    if (typeof func.async === "string") {
      const asyncReturnType = func.parameters.find(
        (param) => param.name === func.async && param.type === "function"
      );
      const unwrappedAsyncReturnType = getType(
        (asyncReturnType?.parameters || []).shift(),
        namespaces,
        currentNamespace
      );

      let optionalFallBackType = "";
      if (
        asyncReturnType?.name == "callback" &&
        asyncReturnType?.optional
      ) {
        optionalFallBackType = " | null";
      }

      const funcParams = func.parameters.filter(
        (param) => param.name !== func.async //&& param.type === "function"
      );

      return {
        returnType: `Promise<${
          unwrappedAsyncReturnType || "any"
        }${optionalFallBackType}>`,
        parameters: funcParams,
      };

      // this must be an unkown error
      return { returnType: "ERR", parameters: [] };
    }

    let functionResultType = "void";
    if (func.returns) {
      const { type } = func.returns;
      // TODO: map array type correctly (via "items")
      functionResultType = type === "array" ? "[]" : type;
    }

    return {
      returnType: func.async === true ? "Promise<any>" : functionResultType,
      parameters,
    };
  };

  const { returnType, parameters } = findReturnType(schemaPart);
  const delimStart = wrapInBrackets ? "(" : "";
  const delimEnd = wrapInBrackets ? ")" : "";

  if (returnType === "ERR") {
    const error = `Unknown async type, namespace ${currentNamespace}, function '${schemaPart.name}': '${schemaPart.async}'`;
    // throw new Error(
    // );
    logger.error(error);
  }
  if (!omitDescription) {
    result += generateDescription(schemaPart);
  }

  // check if we have optional parameters BEFORE defining required parameters
  // if so, add additional function signatures
  const firstOptionalParameterIndex = parameters.findIndex(
    (param) => param.optional
  );
  const allTrailingAreOptional = parameters
    .slice(firstOptionalParameterIndex)
    .every(({ optional }) => optional);

  const reservedWords = ["import", "delete", "class"];
  const isNameReserved = reservedWords.includes(schemaPart.name);
  const funcName = isNameReserved ? `__${schemaPart.name}` : schemaPart.name;
  if (!allTrailingAreOptional) {
    const requireAllParams = (params: SchemaPartFunctionParameter[]) =>
      params.map((parameter) => ({
        ...parameter,
        optional: parameter.name === "callback" ? parameter.optional : false,
      }));

    let params = [...parameters];
    let overrides = "";

    while (params.findIndex(({ optional }) => optional) >= 0) {
      overrides += `  ${delimStart}${omitFunctionKeyword ? "" : "function "}${
        omitFunctionName ? "" : funcName
      }(${generateFunctionParams(requireAllParams(params))})${
        inlineFunction ? " => " : ": "
      }${returnType}${delimEnd}${overrideDelimiter}`;
      overrides += `\n`;
      const firstElementToBeRemoved = params.findIndex(
        ({ optional }) => optional
      );
      params = params.filter((_, index) => index !== firstElementToBeRemoved);
    }

    result += overrides;
    result += `  ${delimStart}${omitFunctionKeyword ? "" : "function "}${
      omitFunctionName ? "" : funcName
    }(${generateFunctionParams(requireAllParams(params))})${
      inlineFunction ? " => " : ": "
    }${returnType}${delimEnd}${overrideDelimiter}`;
    result += `\n`;
  } else {
    result += `  ${delimStart}${omitFunctionKeyword ? "" : "function "}${
      omitFunctionName ? "" : funcName
    }(${generateFunctionParams(parameters)})${
      inlineFunction ? " => " : ": "
    }${returnType}${delimEnd}${overrideDelimiter}`;
    result += `\n`;
  }

  if (isNameReserved) {
    result += `\n export { ${funcName} as ${schemaPart.name} }\n\n`;
  }
  return result;
};

const generateFunctionParams = (parameters: SchemaPartFunctionParameter[]) => {
  const result: string[] = [];
  parameters.forEach((param) => {
    // TODO: this parameter mapping is awful and sloppy - so fix this!
    const functionParam = {
      ...param,
      parameters: param.parameters?.map<SchemaPartFunctionParameter>(
        (item) => ({
          name: item.name || "",
          optional: item.optional ?? false,
          type: item.type || "",
          description: item.description ?? "",
          parameters: [],
        })
      ),
    };
    result.push(
      `${generateDescription(param)}\n${param.name}${
        param.optional ? "?" : ""
      }: ${getType(functionParam)}`.trim()
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
    result += createFunctionDefinition(
      schemaPart,
      currentNamespace,
      undefined,
      namespaces
    );
  });
  return result;
};

const generateEventTypings = (
  currentNamespace: string,
  namespaces: Map<string, SchemaPart>
): string => {
  let result = "";
  const schema = namespaces.get(currentNamespace);
  if (!schema || schema.events.length === 0) {
    return result;
  }

  schema.events.forEach((schemaPart, index) => {
    const dbg = debug(`/* ${index + 1} of ${schema.events.length} */ }`);
    result += `    const ${dbg}${schemaPart.name}: EventHandler<`;
    result += createFunctionDefinition(
      schemaPart,
      "",
      {
        omitFunctionName: true,
        omitFunctionKeyword: true,
        inlineFunction: true,
      overrideDelimiter: " | ",
      wrapInBrackets: true,
      },
      namespaces
    );
    result = result.substring(0, result.length - 4);

    result += `>;\n`;
  });
  return result;
};

const generateNamespacePropertyTypings = (
  currentNamespace: string,
  namespaces: Map<string, SchemaPart>
): string => {
  let result = "";
  const schema = namespaces.get(currentNamespace);
  if (
    !schema ||
    !schema.properties ||
    Object.keys(schema.properties).length === 0
  ) {
    return result;
  }

  Object.entries(schema.properties).forEach(([name, property]) => {
    result += generateDescription(property);
    if (property.$ref) {
      result += `const ${name}: ${getType(property)};\n`;
    } else {
      if (property.value) {
        result += `const ${name} = ${property.value};\n`;
      } else {
        /* TODO: result += `${name}${property.optional ? "?" : ""}: ${getType(
          property
        )}; \n`;*/
      }
    }
  });

  return result;
};

const getType = (
  property:
    | ({
        $ref?: string;
        type?: string;
        enum?: any;
        items?: { type: string } | { $ref: string };
        choices?: SchemaPartType[];
        properties?: {
          [key: string]: SchemaPartType;
        };
        functions?: SchemaPart["functions"];
      } & Partial<
        Pick<
          SchemaPartFunction,
          "async" | "parameters" | "name" | "description" | "returns"
        >
      >)
    | undefined,
  namespaces?: Map<string, SchemaPart>,
  currentNamespace?: string
): string => {
  if (property === undefined) {
    return "void";
  }

  if (property.$ref) {
    if (`${property.$ref}`.indexOf(".") >= 0) {
      const dbg = debug(
        `/* lookup type? "${property.$ref}", optional? ${property.properties?.optional} */`
      );
      return `${dbg} ${property.$ref}`;
    }

    // if no '.' is included it's the local/current namespace
    const namespace = findNamespaceFortype(property.$ref, namespaces);
    if (namespace.length === 0) {
      logger.warn(`ERROR: namespace '${property.$ref}' not found.`);
      return `${property.$ref}`;
    }

    const targetNamespace = namespace.pop();
    if (currentNamespace && targetNamespace === currentNamespace) {
      return `${property.$ref}`;
    }
    return `${targetNamespace}.${property.$ref}`;
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
        const dbg = debug("/* z8array */");
        return `${dbg}${refName}[]`;
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

  if (property.type === "function") {
    const schemaPart: SchemaPartFunction = {
      ...property,
      name: "",
      async: property.async ?? false,
      description: "",
      parameters: property.parameters ?? [],
      returns: property.returns ?? null,
    };
    return `/* or any?  */ ${createFunctionDefinition(
      schemaPart,
      "",
      {
        omitFunctionKeyword: true,
        omitFunctionName: true,
        omitDescription: true,
        inlineFunction: true,
        // overrideDelimiter: ",",
        overrideDelimiter: " , ",
      },
      namespaces
    )} /* x7 */ \n`;
  }

  if (property.type === "any") {
    return "any";
  }

  if (property.type === "object") {
    if (property.properties) {
      const entries = Object.entries(property.properties);
      // console.log(`XX --> ${entries}`);
      let result = "";
      entries.forEach(([name, prop]) => {
        result += generatePropertyTypings({
          name,
          isInterfaceProperty: true,
          ...prop,
        });
      });
      const functions = property.functions || [];
      functions.forEach(({ name }) => {
        console.log(`> func: '${name}`);
      });
      return `{
  ${result}
  }`;
    }
    return `/* "unknown" ${property.properties} */ object`;
  }

  return "void /* could not determine correct type */";
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
    // result += `/* `;
    return result;
  }

  if (property.choices && !property.isInterfaceProperty) {
    result += generateDescription(property);
    result += `  type ${property.name} = ${getType(property)};\n`;
  } else {
    result += generateDescription(property, 1);
    result += `    ${property.name}${property.optional ? "?" : ""}: ${getType(
      property
    )}\n`;
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
      result += `  export interface ${schemaPart.id} {\n`;
      if (schemaPart.properties) {
        const entries = Object.entries(schemaPart.properties);
        entries.forEach(([name, prop]) => {
          result += generatePropertyTypings({
            name,
            isInterfaceProperty: true,
            ...prop,
          });
        });
        result += `\n`;
      }
      if (schemaPart.functions) {
        schemaPart.functions.forEach((func) => {
          result += `${generateDescription(func)}\n`;
          // result += `${func.name}: ${createFunctionDefinition(func, "", {
          result += `${createFunctionDefinition(
            func,
            "",
            {
              omitDescription: true,
              omitFunctionKeyword: true,
            },
            namespaces
          )}\n`;
        });
        result += `\n`;
      }
      result += `  }\n`;
    } else if (schemaPart.type === "string") {
      result += generateDescription(schemaPart);
      result += `  type ${schemaPart.id} = string;`;
    } else if (schemaPart.type === "url") {
      result += generateDescription(schemaPart);
      result += `  type ${schemaPart.id} = string;`;
    } else if (schemaPart.id) {
      result += debug(
        `  /* skipped: ${schemaPart.id}: ${schemaPart.type} */\n`
      );
      result += `  type ${schemaPart.id} = ${getType({ ...schemaPart })};`;
    } else {
      result += debug(
        `  /* skipped: .extend ${(schemaPart as any).$extend}: ${
          schemaPart.type
        } */\n`
      );
    }
    result += `\n`;
  });
  return result;
};

const generateTypingsFile = async (
  outputDirectory: string,
  namespaces: Map<string, SchemaPart>
) => {
  let data = `interface Window {
    browser: typeof browser;
    messenger: typeof browser;
}

import messenger = browser;

interface EventHandler<T> {
  readonly addListener: (callback: T) => void;
  readonly hasListener: (callback: T) => boolean;
  readonly removeListener: (callback: T) => void;
}

`;
  namespaces.forEach((schema, namespace) => {
    data += generateDescription(schema);
    data += `declare namespace browser.${namespace} {\n`;

    data += generateTypeTypings(namespace, namespaces);
    data += generateFunctionTypings(namespace, namespaces);
    data += generateEventTypings(namespace, namespaces);
    data += generateNamespacePropertyTypings(namespace, namespaces);

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
  ignoredNamespaces,
}: {
  readonly schemaDirectory: string;
  readonly browserSchemaDirectory: string;
  readonly outputDirectory: string;
  readonly ignoredNamespaces: string;
}) => {
  const filenames = [
    ...(await readSchemaFileNames(schemaDirectory)),
    ...(await readSchemaFileNames(browserSchemaDirectory)),
  ];

  const schemaParts = await readSchemaFiles(filenames);
  const namespaces = postProcessNamespaces(mergeSchema(schemaParts));

  if (ignoredNamespaces) {
    const ignoredNamespacesList = ignoredNamespaces.split(",");
    ignoredNamespacesList.forEach((ignoredNamespace) =>
      namespaces.delete(ignoredNamespace)
    );
  }

  await generateTypingsFile(outputDirectory, namespaces);
};

generateTypings(cli.flags);
