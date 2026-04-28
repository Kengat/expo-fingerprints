#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <limits>
#include <queue>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

struct Vec2 {
    double x = 0.0;
    double y = 0.0;
};

struct Vec3 {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

struct Face {
    int a = 0;
    int b = 0;
    int c = 0;
};

struct Decal {
    int index = 0;
    Vec3 position;
    Vec3 normal;
    bool hasNormal = false;
    int faceIndex = -1;
    double sizeX = 1.0;
    double sizeY = 1.0;
    double rotation = 0.0;
};

struct Neighbor {
    int tri = -1;
    int keyA = -1;
    int keyB = -1;
};

static Vec3 sub(const Vec3& a, const Vec3& b) {
    return {a.x - b.x, a.y - b.y, a.z - b.z};
}

static Vec3 addScaled(const Vec3& a, const Vec3& b, double s) {
    return {a.x + b.x * s, a.y + b.y * s, a.z + b.z * s};
}

static Vec3 cross(const Vec3& a, const Vec3& b) {
    return {
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x
    };
}

static double dot(const Vec3& a, const Vec3& b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

static double lenSq(const Vec3& a) {
    return dot(a, a);
}

static double len(const Vec3& a) {
    return std::sqrt(lenSq(a));
}

static Vec3 normalize(const Vec3& a) {
    const double l = len(a);
    if (l < 1e-12) return {0.0, 0.0, 0.0};
    return {a.x / l, a.y / l, a.z / l};
}

static Vec3 projectOnPlane(const Vec3& v, const Vec3& normal) {
    return sub(v, {normal.x * dot(v, normal), normal.y * dot(v, normal), normal.z * dot(v, normal)});
}

static Vec2 rotate2(const Vec2& p, double radians) {
    const double c = std::cos(radians);
    const double s = std::sin(radians);
    return {p.x * c - p.y * s, p.x * s + p.y * c};
}

static std::string vertexKey(const Vec3& p) {
    const long long x = llround(p.x * 10000.0);
    const long long y = llround(p.y * 10000.0);
    const long long z = llround(p.z * 10000.0);
    return std::to_string(x) + "|" + std::to_string(y) + "|" + std::to_string(z);
}

static Vec3 closestPointOnTriangle(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) {
    const Vec3 ab = sub(b, a);
    const Vec3 ac = sub(c, a);
    const Vec3 ap = sub(p, a);
    const double d1 = dot(ab, ap);
    const double d2 = dot(ac, ap);
    if (d1 <= 0.0 && d2 <= 0.0) return a;

    const Vec3 bp = sub(p, b);
    const double d3 = dot(ab, bp);
    const double d4 = dot(ac, bp);
    if (d3 >= 0.0 && d4 <= d3) return b;

    const double vc = d1 * d4 - d3 * d2;
    if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
        const double v = d1 / (d1 - d3);
        return addScaled(a, ab, v);
    }

    const Vec3 cp = sub(p, c);
    const double d5 = dot(ab, cp);
    const double d6 = dot(ac, cp);
    if (d6 >= 0.0 && d5 <= d6) return c;

    const double vb = d5 * d2 - d1 * d6;
    if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
        const double w = d2 / (d2 - d6);
        return addScaled(a, ac, w);
    }

    const double va = d3 * d6 - d5 * d4;
    if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) {
        const double w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return addScaled(b, sub(c, b), w);
    }

    const double denom = 1.0 / (va + vb + vc);
    const double v = vb * denom;
    const double w = vc * denom;
    return {a.x + ab.x * v + ac.x * w, a.y + ab.y * v + ac.y * w, a.z + ab.z * v + ac.z * w};
}

static bool chartValid(const std::vector<Vec2>& chart) {
    if (chart.size() != 3) return false;
    for (const auto& p : chart) {
        if (!std::isfinite(p.x) || !std::isfinite(p.y)) return false;
    }
    return true;
}

static bool chartIntersects(const std::vector<Vec2>& chart, const Decal& decal) {
    if (!chartValid(chart) || decal.sizeX <= 0.0 || decal.sizeY <= 0.0) return false;
    double minU = std::numeric_limits<double>::infinity();
    double maxU = -std::numeric_limits<double>::infinity();
    double minV = std::numeric_limits<double>::infinity();
    double maxV = -std::numeric_limits<double>::infinity();
    const double margin = 0.18;
    const double r = -decal.rotation;

    for (const auto& p : chart) {
        const Vec2 rp = rotate2(p, r);
        const double u = rp.x / decal.sizeX + 0.5;
        const double v = rp.y / decal.sizeY + 0.5;
        minU = std::min(minU, u);
        maxU = std::max(maxU, u);
        minV = std::min(minV, v);
        maxV = std::max(maxV, v);
    }
    return maxU >= -margin && minU <= 1.0 + margin && maxV >= -margin && minV <= 1.0 + margin;
}

static int findClosestFace(const std::vector<Vec3>& vertices, const std::vector<Face>& faces, const Vec3& anchor) {
    int best = -1;
    double bestDist = std::numeric_limits<double>::infinity();
    for (int i = 0; i < static_cast<int>(faces.size()); ++i) {
        const Face& f = faces[i];
        if (f.a < 0 || f.b < 0 || f.c < 0 || f.a >= static_cast<int>(vertices.size()) || f.b >= static_cast<int>(vertices.size()) || f.c >= static_cast<int>(vertices.size())) {
            continue;
        }
        const Vec3 cp = closestPointOnTriangle(anchor, vertices[f.a], vertices[f.b], vertices[f.c]);
        const double d = lenSq(sub(cp, anchor));
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    }
    return best;
}

static bool placeNeighbor(
    const std::vector<Vec3>& vertices,
    const std::vector<Face>& faces,
    const std::vector<std::array<int, 3>>& faceKeys,
    int currentTri,
    const std::vector<Vec2>& currentChart,
    int nextTri,
    int sharedA,
    int sharedB,
    std::vector<Vec2>& out
) {
    if (!chartValid(currentChart)) return false;
    const auto& ck = faceKeys[currentTri];
    const auto& nk = faceKeys[nextTri];

    int currentShared[2] = {-1, -1};
    int nextShared[2] = {-1, -1};
    int currentThird = -1;
    int nextThird = -1;

    for (int i = 0; i < 3; ++i) {
        if (ck[i] == sharedA) currentShared[0] = i;
        if (ck[i] == sharedB) currentShared[1] = i;
        if (ck[i] != sharedA && ck[i] != sharedB) currentThird = i;
        if (nk[i] == sharedA) nextShared[0] = i;
        if (nk[i] == sharedB) nextShared[1] = i;
        if (nk[i] != sharedA && nk[i] != sharedB) nextThird = i;
    }
    if (currentShared[0] < 0 || currentShared[1] < 0 || nextShared[0] < 0 || nextShared[1] < 0 || currentThird < 0 || nextThird < 0) return false;

    const Vec2 a2 = currentChart[currentShared[0]];
    const Vec2 b2 = currentChart[currentShared[1]];
    const Vec2 cCurrent = currentChart[currentThird];
    const Vec2 edge = {b2.x - a2.x, b2.y - a2.y};
    const double edgeLen = std::sqrt(edge.x * edge.x + edge.y * edge.y);
    if (edgeLen < 1e-8) return false;

    const Face& nf = faces[nextTri];
    const int nextIndices[3] = {nf.a, nf.b, nf.c};
    const Vec3& a3 = vertices[nextIndices[nextShared[0]]];
    const Vec3& b3 = vertices[nextIndices[nextShared[1]]];
    const Vec3& c3 = vertices[nextIndices[nextThird]];
    const double distA = len(sub(c3, a3));
    const double distB = len(sub(c3, b3));
    if (!std::isfinite(distA) || !std::isfinite(distB)) return false;

    const double x = (distA * distA - distB * distB + edgeLen * edgeLen) / (2.0 * edgeLen);
    const double h = std::sqrt(std::max(0.0, distA * distA - x * x));
    const Vec2 dir = {edge.x / edgeLen, edge.y / edgeLen};
    const Vec2 base = {a2.x + dir.x * x, a2.y + dir.y * x};
    const Vec2 perp = {-dir.y, dir.x};
    const Vec2 candA = {base.x + perp.x * h, base.y + perp.y * h};
    const Vec2 candB = {base.x - perp.x * h, base.y - perp.y * h};

    const double currentSide = edge.x * (cCurrent.y - a2.y) - edge.y * (cCurrent.x - a2.x);
    const double sideA = edge.x * (candA.y - a2.y) - edge.y * (candA.x - a2.x);
    const Vec2 third = (std::abs(currentSide) < 1e-10 || sideA * currentSide < 0.0) ? candA : candB;

    out.assign(3, {});
    out[nextShared[0]] = a2;
    out[nextShared[1]] = b2;
    out[nextThird] = third;
    return chartValid(out);
}

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);

    int vertexCount = 0;
    int faceCount = 0;
    int decalCount = 0;
    if (!(std::cin >> vertexCount >> faceCount >> decalCount)) {
        std::cerr << "Invalid native wrap input header\n";
        return 2;
    }

    std::vector<Vec3> vertices(vertexCount);
    for (int i = 0; i < vertexCount; ++i) {
        std::cin >> vertices[i].x >> vertices[i].y >> vertices[i].z;
    }

    std::vector<Face> faces(faceCount);
    for (int i = 0; i < faceCount; ++i) {
        std::cin >> faces[i].a >> faces[i].b >> faces[i].c;
    }

    std::vector<Decal> decals(decalCount);
    for (int i = 0; i < decalCount; ++i) {
        Decal d;
        std::cin >> d.index
                 >> d.position.x >> d.position.y >> d.position.z
                 >> d.normal.x >> d.normal.y >> d.normal.z
                 >> d.faceIndex >> d.sizeX >> d.sizeY >> d.rotation;
        d.hasNormal = lenSq(d.normal) > 1e-10;
        d.rotation *= 3.14159265358979323846 / 180.0;
        decals[i] = d;
    }

    std::unordered_map<std::string, int> keyIds;
    std::vector<std::array<int, 3>> faceKeys(faceCount);
    int nextKey = 0;
    auto getKeyId = [&](int vertexIndex) {
        const std::string key = vertexKey(vertices[vertexIndex]);
        const auto it = keyIds.find(key);
        if (it != keyIds.end()) return it->second;
        keyIds[key] = nextKey;
        return nextKey++;
    };

    std::unordered_map<std::string, std::vector<int>> edgeMap;
    std::vector<std::vector<Neighbor>> adjacency(faceCount);
    for (int t = 0; t < faceCount; ++t) {
        const int ids[3] = {faces[t].a, faces[t].b, faces[t].c};
        if (ids[0] < 0 || ids[1] < 0 || ids[2] < 0 || ids[0] >= vertexCount || ids[1] >= vertexCount || ids[2] >= vertexCount) continue;
        for (int i = 0; i < 3; ++i) faceKeys[t][i] = getKeyId(ids[i]);
        for (const auto& e : {std::pair<int, int>{0, 1}, {1, 2}, {2, 0}}) {
            const int ka = faceKeys[t][e.first];
            const int kb = faceKeys[t][e.second];
            const int lo = std::min(ka, kb);
            const int hi = std::max(ka, kb);
            const std::string edgeKey = std::to_string(lo) + "_" + std::to_string(hi);
            auto& bucket = edgeMap[edgeKey];
            for (int other : bucket) {
                adjacency[t].push_back({other, lo, hi});
                adjacency[other].push_back({t, lo, hi});
            }
            bucket.push_back(t);
        }
    }

    std::cout << std::setprecision(9);
    std::cout << "{\"decals\":[";
    bool firstDecal = true;

    for (const Decal& decal : decals) {
        int seed = decal.faceIndex >= 0 && decal.faceIndex < faceCount ? decal.faceIndex : findClosestFace(vertices, faces, decal.position);
        if (seed < 0) continue;

        const Face& sf = faces[seed];
        const Vec3& a = vertices[sf.a];
        const Vec3& b = vertices[sf.b];
        const Vec3& c = vertices[sf.c];
        const Vec3 faceNormal = normalize(cross(sub(b, a), sub(c, a)));
        Vec3 normal = decal.hasNormal ? normalize(decal.normal) : faceNormal;
        if (lenSq(normal) < 1e-12) continue;

        Vec3 reference = std::abs(normal.y) < 0.92 ? Vec3{0.0, 1.0, 0.0} : Vec3{1.0, 0.0, 0.0};
        Vec3 tangentX = normalize(cross(reference, normal));
        if (lenSq(tangentX) < 1e-12) tangentX = normalize(projectOnPlane({1.0, 0.0, 0.0}, normal));
        if (lenSq(tangentX) < 1e-12) tangentX = normalize(projectOnPlane({0.0, 1.0, 0.0}, normal));
        const Vec3 tangentY = normalize(cross(normal, tangentX));

        auto project = [&](const Vec3& p) {
            const Vec3 rel = sub(p, decal.position);
            return Vec2{dot(rel, tangentX), dot(rel, tangentY)};
        };

        std::vector<std::vector<Vec2>> charts(faceCount);
        std::vector<uint8_t> seen(faceCount, 0);
        std::queue<int> queue;
        charts[seed] = {project(a), project(b), project(c)};
        seen[seed] = 1;
        queue.push(seed);

        const int maxTriangles = 14000;
        int accepted = 1;
        while (!queue.empty() && accepted < maxTriangles) {
            const int current = queue.front();
            queue.pop();
            for (const Neighbor& n : adjacency[current]) {
                if (n.tri < 0 || n.tri >= faceCount || seen[n.tri]) continue;
                std::vector<Vec2> nextChart;
                if (!placeNeighbor(vertices, faces, faceKeys, current, charts[current], n.tri, n.keyA, n.keyB, nextChart)) continue;
                if (!chartIntersects(nextChart, decal)) continue;
                charts[n.tri] = nextChart;
                seen[n.tri] = 1;
                queue.push(n.tri);
                accepted++;
            }
        }

        std::vector<double> outPositions;
        std::vector<double> outUvs;
        std::vector<double> outNormals;

        for (int t = 0; t < faceCount; ++t) {
            if (!seen[t] || !chartValid(charts[t])) continue;
            if (t != seed && !chartIntersects(charts[t], decal)) continue;
            const Face& f = faces[t];
            const int ids[3] = {f.a, f.b, f.c};
            if (ids[0] < 0 || ids[1] < 0 || ids[2] < 0 || ids[0] >= vertexCount || ids[1] >= vertexCount || ids[2] >= vertexCount) continue;
            const Vec3 fn = normalize(cross(sub(vertices[ids[1]], vertices[ids[0]]), sub(vertices[ids[2]], vertices[ids[0]])));
            if (lenSq(fn) < 1e-12) continue;

            for (int k = 0; k < 3; ++k) {
                const Vec3& p = vertices[ids[k]];
                outPositions.push_back(p.x);
                outPositions.push_back(p.y);
                outPositions.push_back(p.z);

                const Vec2 rp = rotate2(charts[t][k], -decal.rotation);
                outUvs.push_back(rp.x / decal.sizeX + 0.5);
                outUvs.push_back(1.0 - (rp.y / decal.sizeY + 0.5));

                outNormals.push_back(fn.x);
                outNormals.push_back(fn.y);
                outNormals.push_back(fn.z);
            }
        }

        if (outPositions.empty()) continue;

        if (!firstDecal) std::cout << ",";
        firstDecal = false;
        std::cout << "{\"index\":" << decal.index << ",\"positions\":[";
        for (size_t i = 0; i < outPositions.size(); ++i) {
            if (i) std::cout << ",";
            std::cout << outPositions[i];
        }
        std::cout << "],\"uvs\":[";
        for (size_t i = 0; i < outUvs.size(); ++i) {
            if (i) std::cout << ",";
            std::cout << outUvs[i];
        }
        std::cout << "],\"normals\":[";
        for (size_t i = 0; i < outNormals.size(); ++i) {
            if (i) std::cout << ",";
            std::cout << outNormals[i];
        }
        std::cout << "],\"triangles\":" << (outPositions.size() / 9) << "}";
    }

    std::cout << "]}";
    return 0;
}
