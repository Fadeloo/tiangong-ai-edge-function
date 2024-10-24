// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';

import { OpenAIEmbeddings } from '@langchain/openai';
import { Pinecone } from '@pinecone-database/pinecone';
import { createClient, SupabaseClient } from '@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import generateQuery from '../_shared/generate_query.ts';
import supabaseAuth from '../_shared/supabase_auth.ts';

const openai_api_key = Deno.env.get('OPENAI_API_KEY') ?? '';
const openai_embedding_model = Deno.env.get('OPENAI_EMBEDDING_MODEL') ?? '';

const pinecone_api_key = Deno.env.get('PINECONE_API_KEY') ?? '';
const pinecone_index_name = Deno.env.get('PINECONE_INDEX_NAME') ?? '';
const pinecone_namespace_sci = Deno.env.get('PINECONE_NAMESPACE_SCI') ?? '';

const supabase_url = Deno.env.get('LOCAL_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL') ?? '';
const supabase_anon_key =
  Deno.env.get('LOCAL_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const openaiClient = new OpenAIEmbeddings({
  apiKey: openai_api_key,
  model: openai_embedding_model,
});

const pc = new Pinecone({ apiKey: pinecone_api_key });
const index = pc.index(pinecone_index_name);

interface JournalData {
  doi: string;
  title: string;
  authors: string[];
}

async function getMeta(supabase: SupabaseClient, doi: string[]): Promise<JournalData[] | null> {
  const batchSize = 400;
  let allData: JournalData[] = [];

  for (let i = 0; i < doi.length; i += batchSize) {
    const batch = doi.slice(i, i + batchSize);
    const { data, error } = await supabase
      .from('journals')
      .select('doi, title, authors')
      .in('doi', batch);

    if (error) {
      return null;
    }

    allData = allData.concat(data as JournalData[]);
  }

  return allData;
}

function formatTimestampToYearMonth(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = ('0' + (date.getMonth() + 1)).slice(-2);
  return `${year}-${month}`;
}

type FilterType = { journal?: string[]; date?: string } | Record<string | number | symbol, never>;

type JournalCondition = { $or: { journal: string }[] };

type DateCondition = { date: string };
type PCFilter = {
  $and?: (JournalCondition | DateCondition)[];
};

function filterToPCQuery(filter?: FilterType): PCFilter | undefined {
  if (!filter || Object.keys(filter).length === 0) {
    return undefined;
  }

  const conditions = [];

  if (filter.journal) {
    const journalConditions = filter.journal.map((c) => ({ journal: c }));
    conditions.push({ $or: journalConditions });
  }

  if (filter.date) {
    conditions.push({ date: filter.date });
  }
  return conditions.length > 0 ? { $and: conditions } : undefined;
}

const search = async (
  supabase: SupabaseClient,
  semantic_query: string,
  topK: number,
  filter?: FilterType,
) => {
  const searchVector = await openaiClient.embedQuery(semantic_query);

  // console.log(filter);
  // console.log(filterToPCQuery(filter));

  interface QueryOptions {
    vector: number[];
    topK: number;
    includeMetadata: boolean;
    includeValues: boolean;
    filter?: PCFilter;
  }

  const queryOptions: QueryOptions = {
    vector: searchVector,
    topK: topK,
    includeMetadata: true,
    includeValues: false,
  };

  if (filter && Object.keys(filter).length > 0) {
    queryOptions.filter = filterToPCQuery(filter);
  }

  const pineconeResponse = await index.namespace(pinecone_namespace_sci).query(queryOptions);

  // console.log(pineconeResponse);

  const rec_id_set = new Set();
  const unique_docs = [];

  for (const doc of pineconeResponse.matches) {
    if (doc.metadata && doc.metadata.doi) {
      const id = doc.metadata.doi;
      const date = doc.metadata.date as number;

      rec_id_set.add(id);
      unique_docs.push({
        id: String(id),
        text: doc.metadata.text,
        journal: doc.metadata.journal,
        date: formatTimestampToYearMonth(date),
      });
    }
  }

  const uniqueIds = new Set(unique_docs.map((doc) => doc.id));
  // console.log(Array.from(uniqueIds));

  const pgResponse = await getMeta(supabase, Array.from(uniqueIds));

  const docList = unique_docs.map((doc) => {
    const record = pgResponse?.find((r: { doi: string }) => r.doi === doc.id);

    if (record) {
      const title = record.title;
      const journal = doc.journal;
      const authors = record.authors.join(', ');
      const date = doc.date;
      const url = `https://doi.org/${record.doi}`;
      const sourceEntry = `[${title}, ${journal}. ${authors}. ${date}.](${url})`;
      return { content: doc.text, source: sourceEntry };
    } else {
      throw new Error('Record not found');
    }
  });

  return docList;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  const supabase = createClient(supabase_url, supabase_anon_key);
  const authResponse = await supabaseAuth(
    supabase,
    req.headers.get('email') ?? '',
    req.headers.get('password') ?? '',
  );
  if (authResponse.status !== 200) {
    return authResponse;
  }

  const { query, filter, topK = 5 } = await req.json();
  // console.log(query, filter);

  const res = await generateQuery(query);

  const result = await search(supabase, res.semantic_query, topK, filter);
  // console.log(result);

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:64321/functions/v1/sci_search' \
    --header 'Content-Type: application/json' \
    --header 'email: xxx' \
    --header 'password: xxx' \
    --data '{"query": "关键金属物质流的全球贸易特征是什么?", "filter": {"journal": ["JOURNAL OF INDUSTRIAL ECOLOGY"]}, "topK": 3}'
*/
