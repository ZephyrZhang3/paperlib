import Cite from "citation-js";
import { clipboard } from "electron";
import { XMLParser } from "fast-xml-parser";
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";

import { errorcatching } from "@/base/error";
import { createDecorator } from "@/base/injection/injection";
import { formatString } from "@/base/string";
import {
  IPreferenceService,
  PreferenceService,
} from "@/common/services/preference-service";
import { CSL } from "@/models/csl";
import { PaperEntity } from "@/models/paper-entity";
import { ILogService, LogService } from "@/renderer/services/log-service";

export const IReferenceService = createDecorator("referenceService");

export class ReferenceService {
  constructor(
    @IPreferenceService private readonly _preferenceService: PreferenceService,
    @ILogService private readonly _logService: LogService
  ) {
    this._setupCitePlugin();
  }

  private _setupCitePlugin() {
    const parseSingle = (paperEntityDraft: PaperEntity) => {
      let nameArray;
      if (paperEntityDraft.authors.includes(";")) {
        nameArray = paperEntityDraft.authors.split(";");
      } else {
        nameArray = paperEntityDraft.authors.split(",");
      }
      nameArray = nameArray.map((name) => {
        name = name.trim();
        const nameParts = name.split(" ");
        const given = nameParts.slice(0, nameParts.length - 1).join(" ");
        const family = nameParts[nameParts.length - 1];

        return {
          given: given,
          family: family,
        };
      });

      let citeKey = "";
      if (nameArray.length >= 1) {
        citeKey += nameArray[0].family.toLowerCase();
      }
      citeKey += paperEntityDraft.pubTime;
      const titleArray = paperEntityDraft.title.split(" ");
      for (const word of titleArray) {
        if (
          word.toLocaleLowerCase() !== "the" ||
          word.toLocaleLowerCase() !== "a" ||
          word.toLocaleLowerCase() !== "an" ||
          word.length <= 3
        ) {
          citeKey += formatString({
            str: word.toLowerCase(),
            removeNewline: true,
            removeSymbol: true,
            removeWhite: true,
            trimWhite: true,
          });
          break;
        }
      }
      return {
        id: `${paperEntityDraft.id}`,
        type: ["article", "paper-conference", "article", "book"][
          paperEntityDraft.pubType
        ],
        "citation-key": citeKey,
        title: paperEntityDraft.title,
        author: nameArray,
        issued: {
          "date-parts": [[paperEntityDraft.pubTime]],
        },
        "container-title": paperEntityDraft.publication,
        publisher: paperEntityDraft.publisher,
        page: paperEntityDraft.pages,
        volume: paperEntityDraft.volume,
        issue: paperEntityDraft.number,
        DOI: paperEntityDraft.doi,
      };
    };

    const parseMulti = (paperEntityDrafts: PaperEntity[]) => {
      return paperEntityDrafts.map((paperEntityDraft) => {
        return parseSingle(paperEntityDraft);
      });
    };

    const predicateSingle = (paperEntityDraft: PaperEntity) => {
      return paperEntityDraft.codes !== undefined;
    };

    const predicateMulti = (paperEntityDrafts: PaperEntity[]) => {
      if (!!paperEntityDrafts?.[Symbol.iterator]) {
        return paperEntityDrafts.every((paperEntityDraft) => {
          return paperEntityDraft.codes !== undefined;
        });
      } else {
        return false;
      }
    };

    Cite.plugins.input.add("@paperlib/PaperEntity", {
      parse: parseSingle,
      parseType: {
        predicate: predicateSingle,
        dataType: "ComplexObject",
      },
    });
    Cite.plugins.input.add("@paperlib/PaperEntity[]", {
      parse: parseMulti,
      parseType: {
        predicate: predicateMulti,
        dataType: "Array",
      },
    });

    Cite.plugins.output.add("bibtex-key", (csls: CSL[]) => {
      return csls
        .map((csl) => {
          return csl["citation-key"];
        })
        .join(", ");
    });
  }

  /**
   * Abbreviate the publication name.
   * @param source - The source paper entity.
   * @returns - The paper entity with publication name abbreviated.
   */
  replacePublication(source: PaperEntity) {
    try {
      if (this._preferenceService.get("enableExportReplacement")) {
        const pubReplacement = this._preferenceService.get(
          "exportReplacement"
        ) as [{ from: string; to: string }];

        const pubMap = new Map(
          pubReplacement.map((item) => [item.from, item.to])
        );

        if (pubMap.has(source.publication)) {
          source.publication = pubMap.get(source.publication) as string;
        }
      }
      return source;
    } catch (e) {
      this._logService.error(
        `Failed to abbreviate publication name.`,
        e as Error,
        true,
        "ReferenceService"
      );
      return source;
    }
  }

  /**
   * Convert paper entity to cite object.
   * @param source - The source paper entity.
   * @returns - The cite object.
   */
  @errorcatching(
    "Failed to convert paper entity to cite object.",
    true,
    "ReferenceService",
    null
  )
  toCite(source: PaperEntity | PaperEntity[] | string) {
    if (typeof source === "string") {
      return new Cite(source);
    } else if (source.constructor.name === "PaperEntity") {
      return new Cite(this.replacePublication(source as PaperEntity));
    } else {
      return new Cite(
        (source as PaperEntity[]).map((item) => this.replacePublication(item))
      );
    }
  }

  /**
   * Export BibTex key.
   * @param cite - The cite object.
   * @returns - The BibTex key.
   */
  @errorcatching(
    "Failed to convert cite object to BibTex Key.",
    true,
    "ReferenceService",
    ""
  )
  exportBibTexKey(cite: Cite): string {
    return cite.format("bibtex-key");
  }

  /**
   * Export BibTex body string.
   * @param cite - The cite object.
   * @returns - The BibTex body string.
   */
  @errorcatching(
    "Failed to convert cite object to BibTex string.",
    true,
    "ReferenceService",
    ""
  )
  exportBibTexBody(cite: Cite): string {
    const mathEnvStrs: string[] = [];
    let idx = 0;
    for (const i in cite.data) {
      let title: string = cite.data[i].title;
      const envRegex = /\$(.*?)\$/g;
      const envs = title.match(envRegex);
      if (envs) {
        for (const env of envs) {
          mathEnvStrs.push(env);
          title = title.replace(env, `MATHENVDOLLAR{i}`);
          idx += 1;
        }
        cite.data[i].title = title;
      }
    }

    let bibtexBody = escapeLaTexString(cite.format("bibtex"));

    for (const i in mathEnvStrs) {
      bibtexBody = bibtexBody
        .replace(`MATHENVDOLLAR{i}`, mathEnvStrs[i])
        .replace(`{MATHENVDOLLAR}{i}`, mathEnvStrs[i]);
    }

    return bibtexBody;
  }

  async exportPlainText(cite: Cite): Promise<string> {
    const csl = this._preferenceService.get("selectedCSLStyle") as string;

    if (["apa", "vancouver", "harvard1"].includes(csl)) {
      return cite.format("bibliography", { template: csl });
    } else {
      let templatePath = path.join(
        this._preferenceService.get("importedCSLStylesPath") as string,
        csl + ".csl"
      );

      let config = Cite.plugins.config.get("@csl");
      if (existsSync(templatePath)) {
        if (!config.templates.has(csl)) {
          const template = readFileSync(templatePath, "utf8");
          config.templates.add(csl, template);
        }

        return cite.format("bibliography", { template: csl });
      } else {
        this._logService.error(
          `CSL template file: ${csl}.csl not found.`,
          "",
          true,
          "Reference"
        );

        return cite.format("bibliography", { template: "apa" });
      }
    }
  }

  /**
   * Export paper entities.
   * @param paperEntities - The paper entities.
   * @param format - The export format.
   */
  @errorcatching("Failed to export paper entities.", true, "ReferenceService")
  async export(paperEntities: PaperEntity[], format: string) {
    let paperEntityDrafts = paperEntities.map((paperEntity) => {
      return new PaperEntity(paperEntity);
    });

    let copyStr = "";
    if (format === "BibTex") {
      copyStr = this.exportBibTexBody(this.toCite(paperEntityDrafts));
    } else if (format === "BibTex-Key") {
      copyStr = this.exportBibTexKey(this.toCite(paperEntityDrafts));
    } else if (format === "PlainText") {
      copyStr = await this.exportPlainText(this.toCite(paperEntityDrafts));
    }

    clipboard.writeText(copyStr);
  }

  /**
   * Load CSL styles.
   * @returns - The CSL styles.
   */
  @errorcatching("Failed to load CSL styles.", true, "ReferenceService", [])
  async loadCSLStyles(): Promise<{ key: string; name: string }[]> {
    const CSLStyles = [
      {
        key: "apa",
        name: "American Psychological Association",
      },
      {
        key: "vancouver",
        name: "Vancouver",
      },
      {
        key: "harvard1",
        name: "Harvard1",
      },
    ];

    const importedCSLStylesPath = this._preferenceService.get(
      "importedCSLStylesPath"
    ) as string;

    if (importedCSLStylesPath) {
      // List all files in the importedCSLStylesPath
      const files = readdirSync(importedCSLStylesPath);
      const xmlParser = new XMLParser();

      const parsePromise = async (filePath: string) => {
        const fileContent = readFileSync(filePath);
        const xml = xmlParser.parse(fileContent);
        try {
          const name = xml.style.info.title;
          const key = path.basename(filePath, ".csl");
          return { key, name };
        } catch (e) {
          return null;
        }
      };

      const promises: Promise<{
        key: string;
        name: any;
      } | null>[] = [];

      for (const file of files) {
        if (file.endsWith(".csl")) {
          promises.push(parsePromise(path.join(importedCSLStylesPath, file)));
        }
      }

      const importedCSLStyles = (await Promise.all(promises)).filter(
        (item) => item !== null
      ) as { key: string; name: string }[];

      return [...CSLStyles, ...importedCSLStyles];
    }

    return CSLStyles;
  }
}

function escapeLaTexString(str: string) {
  const out = str
    .replaceAll("&", "\\&")
    .replaceAll("%", "\\%")
    .replaceAll("#", "\\#");
  return out;
}