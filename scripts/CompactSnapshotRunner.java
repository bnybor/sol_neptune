import us.solkirkman.g0mirror.CheckpointStore;
import java.io.*;
import java.nio.file.*;
import org.apache.tinkerpop.gremlin.jsr223.GremlinLangScriptEngine;
import org.apache.tinkerpop.gremlin.process.traversal.Traversal;
import org.apache.tinkerpop.gremlin.structure.io.graphson.*;
import org.apache.tinkerpop.shaded.jackson.databind.ObjectMapper;

/** Private benchmark backend; verified isolated snapshots only, no network I/O. */
class CompactSnapshotRunner {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Snapshot and expected source fingerprint required");
        var json = new ObjectMapper();
        var mapper = GraphSONMapper.build().version(GraphSONVersion.V3_0).create().createMapper();
        var loaded = CheckpointStore.readGeneration(Path.of(args[0]), args[1]);
        try (var graph = loaded.graph(); var g = graph.traversal()) {
            var engine = new GremlinLangScriptEngine();
            var bindings = engine.createBindings(); bindings.put("g", g);
            var input = new BufferedReader(new InputStreamReader(System.in, java.nio.charset.StandardCharsets.UTF_8));
            String line;
            while ((line = input.readLine()) != null) {
                String query = json.readValue(line, String.class);
                try (var traversal = (Traversal<?, ?>)engine.eval(query, bindings)) {
                    System.out.println("{\"data\":" + mapper.writeValueAsString(traversal.toList()) + "}");
                }
            }
        }
    }
}
