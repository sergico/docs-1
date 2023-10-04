const utf8Truncate = require("truncate-utf8-bytes");
const {
  mdxNodesToTree,
  computeFrontmatterForTreeNode,
  buildProductVersions,
  replacePathVersion,
} = require("./gatsby-utils.js");
const unified = require("unified");
const rehypeParse = require("rehype-parse");
const hast2string = require("hast-util-to-string");
const visit = require("unist-util-visit-parents");
const mdast2string = require("mdast-util-to-string");
const slugger = require("github-slugger");

// this function is weird - note that it's modifying the node in place
// NOT returning a copy of the node
const mdxNodeToAlgoliaNode = (node, productVersions) => {
  let newNode = node;

  // base
  newNode["title"] = node.frontmatter.title;
  newNode["path"] = node.fields.path;
  newNode["pagePath"] = node.fields.path;

  // optional
  if (node.frontmatter.product) {
    newNode["product"] = node.frontmatter.product;
  }
  if (node.frontmatter.platform) {
    newNode["platform"] = node.frontmatter.platform;
  }

  // docType specific
  if (node.fields.docType == "doc") {
    newNode["product"] = node.fields.product;
    newNode["version"] = node.fields.version;
    newNode["type"] = "doc";

    // switch path to latest (if applicable) to avoid redirects
    const isLatest =
      productVersions[node.fields.product][0] === node.fields.version;
    newNode["isLatest"] = isLatest;
    if (isLatest) {
      const latestPath = replacePathVersion(node.fields.path);
      newNode["path"] = latestPath;
      newNode["pagePath"] = latestPath;
    }
  } else {
    newNode["isLatest"] = true;
    newNode["type"] = "guide";
  }

  // clean up some keys we don't need anymore
  delete newNode["frontmatter"];
  delete newNode["fields"];

  return newNode;
};

//
// Algolia has a hard limit of 10,000 bytes per record. We aim to stay well below that by limiting excerpts
// (normally the largest field) to 8,000 bytes. This is still much larger than is recommended, and simultaneously much
// smaller than some document sections. So the other two limits here try to provide more reasonable cut-offs.
//
// limit excerpt length to at most this many *bytes*
const EXCERPT_HARD_TRUNCATE_BYTES = 8000;
// try to limit excerpt length to at most this many *characters* (allow to go over)
// the purpose of these are to split very long topics at a length likely (though not guaranteed) to fall short of
// the hard limit (at which point the excerpt will be truncated) while keeping relevant text together (e.g. not splitting words or paragraphs).
// this is going to have problems with long strings of symbols, or especially languages that don't use traditional whitespace - but we're not currently
// set up to handle those well for search anyway, so just gonna do the best I can for now and rely on Algolia's tokenizer to get it right in most cases.
const EXCERPT_SOFT_SPLIT_MIN_CHARS = 3000; // start looking for ideal places to break at this length (end of paragraph, list marker, etc.)
const EXCERPT_SOFT_SPLIT_MAX_CHARS = 6000; // start looking for "good enough" places to break at this length (end of word, sentence, etc.)

const mdxTreeToSearchNodes = (rootNode) => {
  const searchNodes = [];
  let headings = [];
  let currentText = "";

  // keep track of the last heading encountered so that subsequent nodes can be tagged with it
  // also keep track of its parent, for those rare cases where a heading is nested below the root
  // (only blockquote, listItem and footnote allow this)
  const observeHeading = (heading, ancestors) => {
    while (
      headings.length &&
      (headings[headings.length - 1].heading.depth >= heading.depth ||
        !ancestors.includes(headings[headings.length - 1].parent))
    )
      headings.pop();

    headings.push({ heading, parent: ancestors[ancestors.length - 1] });
  };

  const storeCurrentText = (ancestors) => {
    if (!currentText.length) return;

    // the parent of the last observed heading should be among the ancestors of the current node for the last heading to be considered relevant.
    while (
      headings.length &&
      !ancestors.includes(headings[headings.length - 1].parent)
    )
      headings.pop();
    const headingNode = headings[headings.length - 1]?.heading;
    const headingId = headingNode && slugger.slug(mdast2string(headingNode));
    const heading = headings.map((h) => mdast2string(h.heading)).join(" » ");
    searchNodes.push({ text: currentText, heading, headingId });

    currentText = "";
  };

  visit(rootNode, (node, ancestors) => {
    if (node.type === "heading") {
      storeCurrentText(ancestors);
      observeHeading(node, ancestors);
      return visit.SKIP;
    }

    // break on new contextual container if current node length exceeds minimum
    const contextTypes = [
      "blockquote",
      "code",
      "listItem",
      "tableRow",
      "thematicBreak",
      "definition",
      "paragraph",
    ];
    if (
      currentText.length >= EXCERPT_SOFT_SPLIT_MIN_CHARS &&
      contextTypes.includes(node.type)
    ) {
      storeCurrentText(ancestors);
    }

    // these are pure JSX directives - don't index.
    if (["import", "export"].includes(node.type)) return visit.SKIP;

    let nodeText = node.value?.trim();

    // these MIGHT be embedded HTML or HTML fragments. Attempt to parse out any relevant text.
    // this ends up being especially important in really boring cases where HTML is used inline,
    // e.g. "Long paragraph with <var>blah</var> somewhere in it."
    if (nodeText && ["html", "jsx"].includes(node.type)) {
      var hast = unified()
        .use(rehypeParse, {
          emitParseErrors: true,
          verbose: true,
          fragment: true,
        })
        .parse(nodeText);
      nodeText = hast2string(hast);
    }

    if (!nodeText) return;

    // this is mostly a fallback for the EXCERPT_SOFT_SPLIT_MIN_CHARS logic above;
    // it'll kick in for really, really long paragraphs and such and decrease the chances
    // of text being truncated at a byte length later on.
    nodeText = nodeText.split(/\s+/);
    do {
      if (currentText.length >= EXCERPT_SOFT_SPLIT_MAX_CHARS) {
        storeCurrentText(ancestors);
      }
      if (currentText.length) currentText += " ";
      currentText += nodeText.shift();
    } while (nodeText.length);
  });

  storeCurrentText([rootNode]);

  return searchNodes;
};

const trimSpaces = (str) => {
  return str.replace(/\s+/g, " ").trim();
};

const buildFinalAlgoliaNodes = (nodes, productVersions) => {
  const result = [];
  for (const node of nodes) {
    const algoliaNode = mdxNodeToAlgoliaNode(node, productVersions);

    // skip indexing this content for now
    if (
      node.path.includes("/postgresql_journey/") ||
      node.path.includes("/playground/")
    ) {
      console.log(`skipped indexing ${node.path}`);
      continue;
    }

    const searchNodes = mdxTreeToSearchNodes(node.mdxAST);

    searchNodes.forEach((searchNode, i) => {
      let newNode = { ...node };
      delete newNode["mdxAST"];

      // this particular naming scheme is important, as algolia defaults to sorting by objectId when
      // other rankings are equal. And it sorts in descending order... So for a given page, where multiple
      // sections may match equally (say, because the match is in the page title) we want earlier sections
      // to rank ahead of later sections.
      newNode.id = `${newNode.algoliaId || newNode.path}${(
        searchNodes.length - i
      )
        .toString()
        .padStart(4, "0")}`;
      delete newNode.algoliaId;
      if (searchNode.heading) newNode.heading = trimSpaces(searchNode.heading);
      if (newNode.heading)
        newNode.title = newNode.title + " » " + newNode.heading;
      newNode.excerpt = utf8Truncate(
        trimSpaces(searchNode.text),
        EXCERPT_HARD_TRUNCATE_BYTES,
      );
      if (searchNode.headingId) {
        newNode.path = `${newNode.path}#${searchNode.headingId}`;
      }

      result.push(newNode);
    });
  }
  return result;
};

const algoliaTransformer = ({ data }) => {
  const mdxNodes = [];

  // build tree to compute inherited frontmatter
  const treeRoot = mdxNodesToTree(data.allMdx.nodes);
  const navStack = [treeRoot];
  let curr = null;

  while (navStack.length > 0) {
    curr = navStack.pop();
    let parentId = curr.mdxNode?.algoliaId;
    let parentDepth = curr.mdxNode?.navDepth || 0;
    for (let child of curr.children)
      if (child.mdxNode)
        child.mdxNode.algoliaId = child.path
          .split("/")
          .slice(-2)[0]
          .toLowerCase();
    const navigation = (curr.mdxNode?.frontmatter?.navigation || [])
      .map((n) => {
        const navName = n.toString().toLowerCase();
        return curr.children.find((c) => c.mdxNode?.algoliaId === navName);
      })
      .filter((n) => !!n);
    navigation.push(
      ...curr.children
        .filter((child) => !navigation.includes(child))
        .sort((a, b) =>
          a.mdxNode?.algoliaId.localeCompare(b.mdxNode?.algoliaId),
        ),
    );
    // used to set fallback sort in algolia to navigation order
    for (let i = 0; i < navigation.length; ++i) {
      if (navigation[i].mdxNode) {
        navigation[i].mdxNode.algoliaId =
          (parentId || navigation[i].path.split("/").slice(0, -2).join("")) +
          (navigation.length - i).toString().padStart(3, "0") +
          navigation[i].mdxNode.algoliaId;
        navigation[i].mdxNode.navDepth = parentDepth + 1;
      }
    }
    navStack.push(...navigation);
    if (!curr.mdxNode) continue;

    curr.mdxNode.frontmatter = computeFrontmatterForTreeNode(curr);
    mdxNodes.push(curr.mdxNode);
  }

  const productVersions = buildProductVersions(data.allMdx.nodes);

  return buildFinalAlgoliaNodes(mdxNodes, productVersions);
};

module.exports = algoliaTransformer;
